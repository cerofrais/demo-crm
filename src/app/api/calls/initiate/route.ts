/**
 * POST /api/calls/initiate
 * Click-to-call: initiate outbound call — Plivo calls the rep first,
 * then the rep answers and we bridge them to the customer.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { can, type AppRole } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { createCall, plivoConfigured, isE164, plivoWebhookBases } from "@/lib/plivo";
import { completeNextRnrTask } from "@/lib/tasks";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const roles = (session.roles ?? []) as AppRole[];
  if (!can(roles, "messaging.send")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!plivoConfigured()) {
    return NextResponse.json({ error: "Plivo is not configured" }, { status: 503 });
  }

  const { guestId, enquiryId, customerPhone } = await req.json();
  if (!customerPhone) {
    return NextResponse.json({ error: "customerPhone required" }, { status: 400 });
  }
  if (!isE164(customerPhone)) {
    // Must be strict E.164 — it is later spliced into Plivo <Dial> XML.
    return NextResponse.json(
      { error: "customerPhone must be E.164 format (e.g. +919812345678)" },
      { status: 400 },
    );
  }

  const sub = session.user.sub ?? (session.user as { sub?: string }).sub ?? (session as unknown as { sub?: string }).sub;
  const keycloakId = sub ?? "";

  // Look up the rep's phone from their staff profile
  const profile = await prisma.staffProfile.findUnique({ where: { keycloakId } });
  if (!profile?.phone) {
    return NextResponse.json(
      { error: "Your phone number is not set. Please add it in Settings → My Profile." },
      { status: 400 },
    );
  }

  // Primary origin, plus a second one handed to Plivo as fallback_url so a
  // tunnel outage can't take out every call (see plivoWebhookBases).
  const [appUrl, fallbackUrl] = plivoWebhookBases();

  // Create the Call record first so we have an ID for customData
  const call = await prisma.call.create({
    data: {
      direction: "outbound",
      status: "initiated",
      guestId: guestId ?? null,
      enquiryId: enquiryId ?? null,
      repKeycloakId: keycloakId,
      repName: session.user.name ?? null,
      repPhone: profile.phone,
      customerPhone,
    },
  });

  // The attempt itself is the follow-up action for an RNR lead — advance the
  // cadence here, at click-to-call, rather than waiting for the call to
  // connect (a Plivo failure below still means the rep tried).
  if (enquiryId) {
    completeNextRnrTask(enquiryId).catch((err) =>
      logger.error({ err, enquiryId }, "calls/initiate: failed to advance RNR cadence"),
    );
  }

  try {
    const result = await createCall({
      to: profile.phone,
      answerUrl: `${appUrl}/api/plivo/outbound-answer`,
      ...(fallbackUrl ? { fallbackUrl: `${fallbackUrl}/api/plivo/outbound-answer` } : {}),
      hangupUrl: `${appUrl}/api/plivo/outbound-hangup`,
      customData: JSON.stringify({ callId: call.id, customerPhone }),
    });

    // Save Plivo's requestUUID as callUUID immediately — this is the same value
    // Plivo sends as CallUUID in answer/hangup webhooks for outbound calls.
    await prisma.call.update({
      where: { id: call.id },
      data: { callUUID: result.requestUUID },
    }).catch(() => null);

    logger.info({ callId: call.id, requestUUID: result.requestUUID }, "outbound call initiated");
    return NextResponse.json({ callId: call.id, requestUUID: result.requestUUID });
  } catch (err) {
    await prisma.call.update({ where: { id: call.id }, data: { status: "failed" } });
    logger.error({ callId: call.id, err }, "plivo createCall failed");
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
