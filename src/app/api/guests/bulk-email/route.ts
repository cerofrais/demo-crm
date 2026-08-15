import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { mailboxForRoles, canSendEmail } from "@/lib/mailboxes";
import { sendEmail, makeMessageId } from "@/lib/mailer";
import { formatPackageForEmail } from "@/lib/packages";
import { personalizeTemplate } from "@/lib/message-templates";
import { sanitizeEmailHtml, extractCidImageIds, buildInlineImageAttachments } from "@/lib/mail-html";
import { getObjectBuffer, headObject } from "@/lib/storage";
import { findBroadcastableDocument } from "@/lib/attachment-access";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { rateLimit, rateLimitResponse, type RateLimitResult } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// F21: safety ceilings so a burst can't trip Gmail's ~500/day limit and get the
// shared mailbox suspended. Env-overridable; defaults kept well below 500.
const MAILBOX_DAILY_CAP = Number(process.env.BULK_EMAIL_MAILBOX_DAILY_CAP ?? 300);
const USER_HOURLY_BULK_CAP = Number(process.env.BULK_EMAIL_USER_HOURLY_CAP ?? 10);

// rateLimitResponse returns a plain Response; wrap it so it satisfies handle()'s
// NextResponse return type without losing the 429 body/headers.
const asNext = (r: Response) =>
  new NextResponse(r.body, { status: r.status, headers: r.headers });

const schema = z.object({
  /** IDs of the guests to email (the client passes what it currently has loaded). */
  guestIds: z.array(z.string().uuid()).min(1).max(500),
  subject: z.string().min(1, "Subject is required"),
  body: z.string().min(1, "Message body is required"),
  html: z.string().optional(),
  /** A Document already created via /api/files/upload-url + /confirm — the
   * same file is attached to every recipient's email (a shared broadcast
   * asset, not scoped to any one guest). */
  attachmentDocumentId: z.string().uuid().optional(),
  /** Optional — appends the package's name/price/duration/therapies to the email.
   * Not a `.uuid()` — some seeded packages use hand-picked ids (e.g. "pkg-day-stress")
   * rather than the Prisma-generated default, so any non-empty string is valid here;
   * the findUnique lookup below is what actually validates it exists. */
  packageId: z.string().min(1).optional(),
});

/**
 * POST /api/guests/bulk-email
 * Send a promotional / broadcast email to a list of guests (sales mailbox).
 * Sends are sequential with a short pause to stay within Gmail rate limits.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    // messaging.broadcast, not messaging.send: this mails every guest in the
    // selection at once. A role allowed to reply to one guest is not
    // automatically allowed to mail the whole directory.
    if (!can(ctx.roles, "messaging.broadcast") || !canSendEmail(ctx.roles)) {
      throw new ApiError("FORBIDDEN", "You cannot send bulk email", 403);
    }
    const mailbox = mailboxForRoles(ctx.roles);
    if (!mailbox || !mailbox.configured) {
      throw new ApiError("NO_MAILBOX", "No email mailbox is configured for your role.", 400);
    }

    // F21: per-user per-hour bulk-invocation cap (checked before any mailer work).
    const userLimit = await rateLimit({
      key: `bulk-email:user:${ctx.sub}`,
      limit: USER_HOURLY_BULK_CAP,
      windowSec: 3600,
    });
    if (!userLimit.allowed) return asNext(rateLimitResponse(userLimit));

    const { guestIds, subject, body, html: rawHtml, attachmentDocumentId, packageId } =
      schema.parse(await req.json());
    const html = rawHtml ? sanitizeEmailHtml(rawHtml) : undefined;

    // F15: canSendEmail alone defeats leads.ownOnly — a RECEPTION/STAFF sender
    // could blast guests they don't own. Non-managers may only email guests for
    // whom they own an enquiry; refuse the whole request if any aren't owned.
    if (!can(ctx.roles, "leads.manage")) {
      const owned = await prisma.guest.findMany({
        where: { id: { in: guestIds }, enquiries: { some: { assignedToSub: ctx.sub } } },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((g) => g.id));
      const notOwned = guestIds.filter((id) => !ownedIds.has(id));
      if (notOwned.length > 0) {
        throw new ApiError(
          "FORBIDDEN",
          `You can only email your own guests (${notOwned.length} not owned).`,
          403,
        );
      }
    }

    let finalBody = body;
    if (packageId) {
      const pkg = await prisma.package.findUnique({ where: { id: packageId } });
      if (!pkg) throw new ApiError("NOT_FOUND", "Package not found", 404);
      finalBody = `${body}\n\n---\n${formatPackageForEmail(pkg)}`;
    }

    // The attached file and any inline images are the SAME asset for every
    // recipient (a shared broadcast attachment, not per-guest) — fetch each
    // once here rather than re-downloading it from storage per send.
    let sharedAttachment: { filename: string; content: Buffer; contentType?: string } | null = null;
    if (attachmentDocumentId) {
      // Library files only, and only in a category this sender may read. An
      // unscoped lookup here would take ANY document id in the system — one
      // guest's medical scan, attached by id and mailed to a whole list.
      const doc = await findBroadcastableDocument(attachmentDocumentId, ctx.roles);
      if (!doc) throw new ApiError("NOT_FOUND", "Attachment not found", 404);
      const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
      const head = await headObject(doc.storageKey);
      if (head.contentLength > MAX_ATTACHMENT_BYTES) {
        throw new ApiError("PAYLOAD_TOO_LARGE", "Attachment exceeds the 20MB email limit", 413);
      }
      const content = await getObjectBuffer(doc.storageKey);
      sharedAttachment = { filename: doc.filename, content, contentType: doc.mimeType };
    }
    const inlineImages = await buildInlineImageAttachments(extractCidImageIds(html));
    const attachments = [
      ...(sharedAttachment ? [sharedAttachment] : []),
      ...inlineImages,
    ];

    // Fetch matching guests that actually have an email address.
    const guests = await prisma.guest.findMany({
      where: { id: { in: guestIds }, email: { not: null }, deletedAt: null },
      select: { id: true, email: true, fullName: true, gender: true },
    });

    // F21: daily recipient counter keyed on the SHARED mailbox (not the user) —
    // this is what actually protects the Gmail account. Reserve this batch's
    // recipients; if it would exceed the cap, release the reservation and 429.
    // Fails open (Redis blip -> unmetered) rather than dropping legit sends.
    if (guests.length > 0) {
      try {
        const mbKey = `rl:bulk-email:mailbox:${mailbox.id}:day`;
        const total = await redis.incrby(mbKey, guests.length);
        if (total === guests.length) await redis.expire(mbKey, 86400);
        if (total > MAILBOX_DAILY_CAP) {
          await redis.decrby(mbKey, guests.length).catch(() => {});
          const ttl = await redis.ttl(mbKey);
          const result: RateLimitResult = {
            allowed: false,
            remaining: Math.max(0, MAILBOX_DAILY_CAP - (total - guests.length)),
            limit: MAILBOX_DAILY_CAP,
            resetSec: ttl > 0 ? ttl : 86400,
          };
          return asNext(rateLimitResponse(result));
        }
      } catch (err) {
        logger.warn({ err, mailbox: mailbox.id }, "bulk-email: mailbox daily cap bypassed — Redis unavailable");
      }
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const guest of guests) {
      if (!guest.email) continue;
      // {name}/{salutation} — same personalization tokens as the WhatsApp
      // broadcast, applied per recipient (subject/body up to here are the
      // same for everyone).
      const personalSubject = personalizeTemplate(subject, { name: guest.fullName, gender: guest.gender });
      const personalBody = personalizeTemplate(finalBody, { name: guest.fullName, gender: guest.gender });
      const personalHtml = html ? personalizeTemplate(html, { name: guest.fullName, gender: guest.gender }) : undefined;
      try {
        const res = await sendEmail(mailbox, {
          to: guest.email,
          subject: personalSubject,
          text: personalBody,
          html: personalHtml,
          attachments: attachments.length ? attachments : undefined,
        });
        await prisma.message.create({
          data: {
            guestId: guest.id,
            mailboxId: mailbox.id,
            channel: "email",
            direction: "outbound",
            subject: personalSubject,
            body: personalBody,
            bodyHtml: personalHtml ?? null,
            attachmentDocumentId: attachmentDocumentId ?? null,
            fromEmail: mailbox.address,
            toEmail: guest.email,
            messageId: res.messageId,
            status: "sent",
          },
        });
        sent++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : "send failed";
        errors.push(`${guest.fullName} <${guest.email}>: ${msg}`);
        logger.error({ err, guestId: guest.id }, "bulk email send failed");
      }
      // Small pause — Gmail allows ~500/day but throttles bursts.
      await new Promise((r) => setTimeout(r, 150));
    }

    await prisma.activity.create({
      data: {
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "bulk_email_sent",
        metadata: { subject, total: guests.length, sent, failed, mailbox: mailbox.id, packageId: packageId ?? null },
      },
    });

    return ok({ sent, skipped: guestIds.length - guests.length, failed, errors });
  });
}
