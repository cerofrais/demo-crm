/**
 * The handlers behind GET/POST /api/webhooks/whatsapp-cloud — Meta's own
 * WhatsApp Cloud API webhook, called by Meta directly.
 *
 * They live in lib rather than in the route file because two routes serve
 * them: the name above, and the older /api/webhooks/whatsapp-cloud-relay,
 * which is the URL currently registered with Meta. A Next.js route module may
 * only export handlers, so sharing them has to go through a module like this
 * one rather than one route re-exporting the other.
 *
 * This used to be a pass-through to Evolution API's /webhook/meta (hence the
 * old route name, whatsapp-cloud-relay, still served as an alias so Meta's
 * existing subscription keeps working). Evolution added nothing on this path
 * — its Cloud API mode is a proxy over the same Graph endpoints we now call
 * ourselves — and it actively lost data: v2.3.7 crashes internally right
 * after logging a Cloud API status webhook (`TypeError: Cannot read
 * properties of undefined (reading 'name')` in `ChannelStartupService`,
 * confirmed against its own container logs), so it never re-emitted the
 * event and a Cloud API message's status stayed on "sent" forever no matter
 * what Meta reported. Statuses were already being parsed here to work around
 * that; inbound messages now are too, and Evolution is out of the Cloud API
 * path entirely. It still serves the QR-paired Baileys numbers, which post
 * to /api/webhooks/whatsapp.
 *
 * Always answers 200 on POST, even when handling fails: Meta retries a
 * non-2xx with backoff for up to 7 days, and a bug in our own storage should
 * not turn into a redelivery storm. Failures go to the log instead.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { WhatsAppNumber } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applyWhatsAppStatusUpdate, sentAtFrom } from "@/lib/whatsapp";
import { cloudApiCredsOf, fetchCloudApiMedia } from "@/lib/whatsapp-cloud-api";
import { ingestWhatsAppMessage } from "@/lib/whatsapp-ingest";
import {
  contactNameFor,
  metaMediaOf,
  metaMessageBody,
  metaValues,
  toE164,
  type MetaMessage,
  type MetaStatus,
  type MetaValue,
  type MetaWebhookBody,
} from "@/lib/whatsapp-cloud-inbound";

/**
 * Meta signs every webhook POST with an HMAC-SHA256 of the RAW body under the
 * app secret. Verified before anything in the payload is trusted — this route
 * creates leads and rewrites delivery statuses, so an unauthenticated one is
 * a write endpoint for anyone who learns the URL.
 *
 * Returns true when the secret isn't configured, so setting META_APP_SECRET
 * is a deliberate step rather than something a deploy silently depends on —
 * but every such request is logged as unverified.
 */
function signatureOk(rawBody: string, header: string | null): boolean {
  const secret = env.META_APP_SECRET;
  if (!secret) {
    logger.warn(
      "whatsapp cloud webhook: META_APP_SECRET is unset — accepting an unverified payload",
    );
    return true;
  }
  const provided = header?.startsWith("sha256=") ? header.slice(7) : null;
  if (!provided) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Meta's subscription handshake: echo hub.challenge if the token matches. */
export async function handleMetaVerify(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  const expected = env.WA_BUSINESS_TOKEN_WEBHOOK;

  if (mode === "subscribe" && challenge && expected && token === expected) {
    logger.info("whatsapp cloud webhook: verification handshake accepted");
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  logger.warn(
    { mode, hasChallenge: Boolean(challenge), configured: Boolean(expected) },
    "whatsapp cloud webhook: verification handshake rejected",
  );
  return new NextResponse("Forbidden", { status: 403 });
}

async function applyStatuses(statuses: MetaStatus[]): Promise<void> {
  for (const status of statuses) {
    if (!status.id || !status.status) continue;
    const err = status.errors?.[0];
    const errorDetail = err
      ? `${err.code ?? "?"}: ${err.error_data?.details ?? err.title ?? err.message ?? "Delivery failed"}`
      : null;
    try {
      await applyWhatsAppStatusUpdate(status.id, status.status, errorDetail);
    } catch (err) {
      logger.error({ err, wamid: status.id }, "whatsapp cloud webhook: failed to apply status update");
    }
  }
}

async function storeMessage(number: WhatsAppNumber, value: MetaValue, msg: MetaMessage): Promise<void> {
  if (!msg.id || !msg.from) return;

  const media = metaMediaOf(msg);
  const timestamp = msg.timestamp ? Number(msg.timestamp) : undefined;

  await ingestWhatsAppMessage(number, {
    externalId: msg.id,
    phone: toE164(msg.from),
    // Meta only delivers messages TO the business; our own sends never come
    // back as an echo the way Baileys mirrors a linked phone's traffic. They
    // are already stored at send time by /api/messages/whatsapp.
    fromMe: false,
    pushName: contactNameFor(value, msg.from),
    sentAt: sentAtFrom(timestamp),
    inReplyTo: msg.context?.id ?? null,
    body: metaMessageBody(msg, media),
    media: media
      ? {
          mimeType: media.mimeType,
          fileName: media.fileName,
          download: async () => fetchCloudApiMedia(cloudApiCredsOf(number), media.mediaId),
        }
      : null,
  });
}

export async function handleMetaWebhook(req: NextRequest) {
  const rawBody = await req.text();
  if (!signatureOk(rawBody, req.headers.get("x-hub-signature-256"))) {
    logger.warn("whatsapp cloud webhook: rejected a payload with a bad signature");
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Bad signature" } }, { status: 403 });
  }

  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    logger.warn("whatsapp cloud webhook: payload was not JSON");
    return NextResponse.json({ ok: true });
  }

  const values = metaValues(body);
  let messageCount = 0;
  let statusCount = 0;

  for (const value of values) {
    // Everything in a `value` is gated on it naming a Phone Number id we
    // actually own. Meta's own payloads always do; a forged one has to guess
    // it. That matters most for statuses, which carry no other identifying
    // field — without this check an unsigned POST could rewrite the delivery
    // status of any message whose wamid the sender knows. Messages were
    // already covered (an unknown id had no number to attach them to); this
    // makes the rule one place rather than two, and it holds whether or not
    // META_APP_SECRET is configured.
    const phoneNumberId = value.metadata?.phone_number_id;
    const number = phoneNumberId
      ? await prisma.whatsAppNumber.findFirst({ where: { metaPhoneNumberId: phoneNumberId } })
      : null;
    if (!number) {
      logger.warn(
        { phoneNumberId, messages: value.messages?.length ?? 0, statuses: value.statuses?.length ?? 0 },
        "whatsapp cloud webhook: payload names a phone number id we do not own — ignoring",
      );
      continue;
    }

    const statuses = value.statuses ?? [];
    statusCount += statuses.length;
    await applyStatuses(statuses);

    for (const msg of value.messages ?? []) {
      messageCount++;
      try {
        await storeMessage(number, value, msg);
      } catch (err) {
        logger.error({ err, wamid: msg.id }, "whatsapp cloud webhook: failed to store inbound message");
      }
    }
  }

  // Logged on SUCCESS, not just failure. This route used to be silent unless
  // it threw, so when Meta stopped reaching it there was nothing to notice:
  // inbound messages and delivery statuses simply stopped for a day and the
  // only symptom was outbound messages sitting on one tick. A line per
  // delivery makes "is Meta still calling us?" answerable from the logs
  // instead of inferred from the absence of replies.
  logger.info({ messages: messageCount, statuses: statusCount }, "whatsapp cloud webhook: received");
  return NextResponse.json({ ok: true });
}
