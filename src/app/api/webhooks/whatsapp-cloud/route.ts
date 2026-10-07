/**
 * GET/POST /api/webhooks/whatsapp-cloud — Meta's WhatsApp Cloud API webhook.
 * Implementation in lib/whatsapp-cloud-webhook.ts, shared with the older
 * /api/webhooks/whatsapp-cloud-relay path that Meta is currently pointed at.
 */
import type { NextRequest } from "next/server";
import { handleMetaVerify, handleMetaWebhook } from "@/lib/whatsapp-cloud-webhook";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleMetaVerify(req);
}

export async function POST(req: NextRequest) {
  return handleMetaWebhook(req);
}
