/**
 * POST /api/guests/broadcast — start a bulk WhatsApp broadcast to a filtered
 * guest list (the client's currently-visible list, same as bulk email).
 * Runs in the background (see src/lib/broadcast.ts + instrumentation-node.ts)
 * — this just enqueues the job. Only one active broadcast at a time.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAllPermissions, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { canUseWhatsAppIntegration } from "@/lib/rbac";
import { allowedWhatsAppNumbersFor, isNumberAllowed } from "@/lib/whatsapp-number-access";
import { startBroadcast } from "@/lib/broadcast";
import { normalizeReplyTag } from "@/lib/reply-tag";
import { MAX_BROADCAST_RECIPIENTS } from "@/lib/limits";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  message: z.string().max(2000).default(""),
  guestIds: z.array(z.string().uuid()).max(MAX_BROADCAST_RECIPIENTS).default([]),
  delaySec: z.number().int().min(1).max(300).default(3),
  numberId: z.string().uuid().optional(),
  imageDocumentId: z.string().uuid().optional(),
  /** Applied to a lead when that guest replies to this broadcast. */
  replyTag: z.string().max(64).optional(),
  /** ISO time to hold the send until. Omitted = send now. */
  scheduledAt: z.coerce.date().optional(),
  /** Follow up this earlier campaign's engaged-then-quiet guests. */
  followUpOfJobId: z.string().uuid().optional(),
  /** Narrow to guests whose reply contained this (e.g. a button's label). */
  followUpTrigger: z.string().max(120).optional(),
  /** Skip anyone we've contacted within this many hours. */
  followUpQuietHours: z.number().int().min(0).max(720).optional(),
  /** Chase each guest individually until this time instead of one batch. */
  followUpRollingUntil: z.coerce.date().optional(),
  /** Cloud API numbers only — send this approved template instead of `message`. */
  template: z
    .object({
      name: z.string().min(1),
      language: z.string().min(1),
      bodyParams: z.array(z.string()).default([]),
      /** Set only for a NAMED-parameter template ({{customer_name}}) — see broadcast.ts. */
      bodyParamNames: z.array(z.string()).optional(),
    })
    .optional(),
}).refine((v) => v.message.trim().length > 0 || v.template, {
  message: "Either a message or a template is required",
  path: ["message"],
}).refine((v) => v.followUpOfJobId || v.guestIds.length > 0, {
  message: "Pick at least one recipient",
  path: ["guestIds"],
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    // WhatsApp broadcast is a Guests-page feature — messaging.send alone
    // isn't enough (Sales holds it for per-lead chat but has no guests.view
    // and shouldn't be able to reach this via a direct API call).
    const ctx = await requireAllPermissions(["messaging.broadcast", "guests.view"]);
    const input = postSchema.parse(await req.json());

    // A follow-up carries no client-supplied list: its recipients are
    // resolved when it starts, so that everyone who replies or calls during
    // the wait drops out (see lib/broadcast-followup.ts).
    let guestIds: string[] = [];
    if (input.followUpOfJobId) {
      const parent = await prisma.broadcastJob.findUnique({
        where: { id: input.followUpOfJobId },
        select: { id: true },
      });
      if (!parent) throw new ApiError("NOT_FOUND", "That campaign no longer exists", 404);
    } else {
      // Restrict to guests that actually have a phone — anything else would
      // just be recorded as an immediate per-recipient failure by the worker.
      const withPhone = await prisma.guest.findMany({
        where: { id: { in: input.guestIds }, deletedAt: null, phone: { not: null } },
        select: { id: true },
      });
      if (withPhone.length === 0) {
        throw new ApiError("VALIDATION_ERROR", "None of the selected guests have a phone number on file", 400);
      }
      guestIds = withPhone.map((g) => g.id);
    }

    // Same restrictions as a 1:1 send. Checked here rather than only in the
    // composer because a broadcast reaches thousands at once — the number
    // most worth protecting is exactly the one a bulk send would burn.
    //
    // With no line chosen the job falls back to the org default, resolved in
    // lib/broadcast.ts with this exact query. For someone an admin has pinned
    // to specific lines that default is resolved HERE and checked too —
    // otherwise leaving the picker on "default" would be a way round the pin.
    const allowed = await allowedWhatsAppNumbersFor(ctx.sub);
    const chosen = input.numberId
      ? await prisma.whatsAppNumber.findUnique({
          where: { id: input.numberId },
          select: { id: true, integration: true, phoneNumber: true },
        })
      : allowed
        ? await prisma.whatsAppNumber.findFirst({
            where: { status: "connected" },
            orderBy: [{ isDefault: "desc" }, { label: "asc" }],
            select: { id: true, integration: true, phoneNumber: true },
          })
        : null;
    if (chosen && !canUseWhatsAppIntegration(ctx.roles, chosen.integration)) {
      throw new ApiError(
        "FORBIDDEN",
        "Only Admin, Manager and Doctor can broadcast from the official WhatsApp number.",
        403,
      );
    }
    if (allowed && !isNumberAllowed(allowed, chosen?.phoneNumber)) {
      throw new ApiError(
        "FORBIDDEN",
        input.numberId
          ? "You aren't assigned to send from this WhatsApp number. An admin can change that on the Users page."
          : "Choose one of your assigned WhatsApp numbers — the default number isn't one of them.",
        403,
      );
    }
    // Pinned onto the job for a restricted sender. A scheduled broadcast
    // resolves "default" again when it runs, and the default can change in the
    // meantime — the line that was checked must be the line that sends.
    const numberId = input.numberId ?? (allowed ? chosen?.id : undefined);

    try {
      const job = await startBroadcast({
        message: input.message,
        guestIds,
        delaySec: input.delaySec,
        numberId,
        imageDocumentId: input.imageDocumentId,
        createdBySub: ctx.sub,
        replyTag: normalizeReplyTag(input.replyTag),
        scheduledAt: input.scheduledAt ?? null,
        followUpOfJobId: input.followUpOfJobId ?? null,
        followUpTrigger: input.followUpTrigger?.trim() || null,
        followUpQuietHours: input.followUpQuietHours ?? null,
        followUpRollingUntil: input.followUpRollingUntil ?? null,
        template: input.template,
      });
      return ok({ id: job.id, status: job.status, totalCount: job.totalCount, scheduledAt: job.scheduledAt });
    } catch (err) {
      throw new ApiError("CONFLICT", err instanceof Error ? err.message : "Couldn't start broadcast", 409);
    }
  });
}
