import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createEnquiry } from "@/lib/enquiry-service";
import { enquiryWebhookSchema } from "@/lib/validation";
import { redis } from "@/lib/redis";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// F22: abuse ceilings for the public webhook. Env-overridable.
const WEBHOOK_IP_PER_MIN = Number(process.env.ENQUIRY_WEBHOOK_IP_PER_MIN ?? 30);
const WEBHOOK_SOURCE_PER_MIN = Number(process.env.ENQUIRY_WEBHOOK_SOURCE_PER_MIN ?? 60);
const WEBHOOK_UNASSIGNED_DAILY_CAP = Number(
  process.env.ENQUIRY_WEBHOOK_UNASSIGNED_DAILY_CAP ?? 500,
);

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * POST /api/webhooks/enquiry-form — multi-source Kanban auto-onboarding (§6.3).
 * Public endpoint: protected by HMAC-SHA256 over the raw body, NOT by a session.
 * Website forms / landing pages / Zapier etc. POST here to drop a card on the
 * board. Idempotency-Key prevents duplicate cards on provider retries.
 *
 * Signature header: X-Signature: sha256=<hex(hmac(secret, rawBody))>
 */
export async function POST(req: NextRequest) {
  // F22: rate-limit BEFORE the signature check so unsigned floods are cheap to
  // reject (per-IP and per-source-id). `x-source-id` identifies the integration
  // (Zapier/landing page); falls back to IP when the caller omits it.
  const ip = clientIp(req);
  const ipLimit = await rateLimit({
    key: `webhook:enquiry:ip:${ip}`,
    limit: WEBHOOK_IP_PER_MIN,
    windowSec: 60,
  });
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit);

  const sourceId = req.headers.get("x-source-id") ?? ip;
  const srcLimit = await rateLimit({
    key: `webhook:enquiry:src:${sourceId}`,
    limit: WEBHOOK_SOURCE_PER_MIN,
    windowSec: 60,
  });
  if (!srcLimit.allowed) return rateLimitResponse(srcLimit);

  const raw = await req.text();
  const signature = req.headers.get("x-signature") ?? "";

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", env.ENQUIRY_WEBHOOK_SECRET)
      .update(raw)
      .digest("hex");

  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  if (!valid) {
    logger.warn("enquiry webhook: bad signature");
    return NextResponse.json(
      { error: { code: "BAD_SIGNATURE", message: "Invalid signature" } },
      { status: 403 },
    );
  }

  // F22: require a server-side idempotency key — without it, provider retries
  // (or a malicious caller) create duplicate leads at will.
  const idem = req.headers.get("idempotency-key");
  if (!idem) {
    return NextResponse.json(
      { error: { code: "IDEMPOTENCY_REQUIRED", message: "Idempotency-Key header is required" } },
      { status: 400 },
    );
  }

  // Idempotency (24h TTL)
  try {
    const set = await redis.set(`webhook:enquiry:${idem}`, "1", "EX", 86400, "NX");
    if (set === null) return NextResponse.json({ data: { duplicate: true } });
  } catch (err) {
    // F41: Redis outage means we can't dedupe — proceed rather than drop the
    // lead, but log loudly so the silent duplicate-lead risk is visible.
    logger.warn({ err, idem }, "enquiry webhook: idempotency check bypassed — Redis unavailable");
  }

  // F22: cap unassigned new-lead creation per day so a signed-key leak can't be
  // used to flood the board. Fails open on Redis error (see idempotency above).
  const dayLimit = await rateLimit({
    key: "webhook:enquiry:unassigned:day",
    limit: WEBHOOK_UNASSIGNED_DAILY_CAP,
    windowSec: 86400,
  });
  if (!dayLimit.allowed) return rateLimitResponse(dayLimit);

  try {
    const input = enquiryWebhookSchema.parse(JSON.parse(raw));
    const result = await createEnquiry(
      { ...input, note: input.intakeNotes ?? input.message, externalRef: idem },
      null, // inbound: unassigned, picked up on the board
    );
    logger.info(
      { enquiryId: result.enquiry.id, returning: result.returning.isReturning },
      "enquiry webhook: card created",
    );
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (err) {
    logger.error({ err }, "enquiry webhook: processing failed");
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid payload" } },
      { status: 400 },
    );
  }
}

// Meta-style verification challenge (optional; mirrors WhatsApp webhook setup)
export async function GET(req: NextRequest) {
  const challenge = req.nextUrl.searchParams.get("hub.challenge");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  if (token && token === env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ status: "ok" });
}
