/**
 * GET/POST /api/webhooks/whatsapp-cloud-relay — transparent pass-through to
 * Evolution API's own Meta Cloud API webhook receiver (`/webhook/meta`), PLUS
 * a direct parse of Meta's own payload for delivery-status updates.
 *
 * Meta's WhatsApp Cloud API webhook (used by a WHATSAPP-BUSINESS-integration
 * instance, as opposed to our existing QR-paired WHATSAPP-BAILEYS numbers)
 * must be reachable at a public HTTPS URL that Meta's own servers call into.
 * This app is the only thing this deployment exposes publicly (the ngrok
 * tunnel only forwards to nextjs:3000) — Evolution API itself only has an
 * internal docker-network address. Evolution already fully implements Meta's
 * webhook contract (the GET verify-challenge handshake and POST event
 * ingestion, gated by its own WA_BUSINESS_TOKEN_WEBHOOK) at /webhook/meta, so
 * the relay itself forwards the method, query string, and body verbatim, and
 * mirrors whatever Evolution responds with.
 *
 * The status-update piece exists because Evolution v2.3.7 crashes internally
 * right after logging a Cloud API status webhook (`TypeError: Cannot read
 * properties of undefined (reading 'name')` in `ChannelStartupService`,
 * confirmed against its own container logs) — it never reaches the point of
 * re-emitting the event to our WEBHOOK_GLOBAL_URL as `messages.update`, so a
 * Cloud API message's status stays stuck on "sent" forever in the CRM no
 * matter what Meta actually reports (delivered/read/failed all get lost).
 * Rather than wait on an upstream fix, `statuses[]` entries are parsed
 * straight out of Meta's own payload here and applied directly — same DB
 * update `applyWhatsAppStatusUpdate` already does for Baileys numbers via
 * Evolution's (working) relay of *that* channel's status events. This runs
 * independently of, and before, the relay to Evolution below, so it isn't
 * affected by whatever Evolution does with the rest of the payload
 * (inbound `messages[]` entries still go through Evolution as before).
 */
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { applyWhatsAppStatusUpdate } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

interface MetaStatusError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

interface MetaStatus {
  id?: string;
  status?: string;
  errors?: MetaStatusError[];
}

interface MetaWebhookValue {
  statuses?: MetaStatus[];
}

interface MetaWebhookBody {
  // Standard envelope: object.entry[].changes[].value
  entry?: { changes?: { value?: MetaWebhookValue }[] }[];
  // Defensive fallback in case the value object is ever posted unwrapped.
  statuses?: MetaStatus[];
}

function extractStatuses(body: MetaWebhookBody): MetaStatus[] {
  const fromEntries = (body.entry ?? []).flatMap((e) =>
    (e.changes ?? []).flatMap((c) => c.value?.statuses ?? []),
  );
  return fromEntries.length ? fromEntries : (body.statuses ?? []);
}

async function applyMetaStatuses(rawBody: string): Promise<void> {
  let parsed: MetaWebhookBody;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return; // not JSON — nothing to extract, the relay below still forwards it verbatim
  }

  for (const status of extractStatuses(parsed)) {
    if (!status.id || !status.status) continue;
    const err = status.errors?.[0];
    const errorDetail = err
      ? `${err.code ?? "?"}: ${err.error_data?.details ?? err.title ?? err.message ?? "Delivery failed"}`
      : null;
    try {
      await applyWhatsAppStatusUpdate(status.id, status.status, errorDetail);
    } catch (err) {
      logger.error({ err, wamid: status.id }, "whatsapp cloud relay: failed to apply status update");
    }
  }
}

async function relay(req: NextRequest): Promise<NextResponse> {
  const target = `${env.EVOLUTION_API_URL}/webhook/meta${req.nextUrl.search}`;
  try {
    const init: RequestInit = { method: req.method };
    if (req.method === "POST") {
      const rawBody = await req.text();
      await applyMetaStatuses(rawBody);
      init.body = rawBody;
      init.headers = { "Content-Type": req.headers.get("content-type") ?? "application/json" };
    }
    const res = await fetch(target, init);
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "text/plain" },
    });
  } catch (err) {
    logger.error({ err, target }, "whatsapp cloud relay: forwarding to Evolution API failed");
    return NextResponse.json({ error: { code: "BAD_GATEWAY", message: "Upstream unavailable" } }, { status: 502 });
  }
}

export const GET = relay;
export const POST = relay;
