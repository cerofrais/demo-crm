/**
 * Plivo webhook: customer called the Plivo number.
 * Routes to the lead's assigned owner first, falling back to sticky/round-
 * robin (see pickRepForCaller), and bridges the call with recording.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { inboundAnswerXml, noAgentXml, verifiedPlivoBase, formToParams, normalizeInboundPhone } from "@/lib/plivo";
import { pickRepForCaller, type CallAssignmentRestriction } from "@/lib/calls";
import { reviveEnquiryIfDeleted } from "@/lib/enquiries";
import { getCallCategoryAssignmentSettings } from "@/lib/lead-assignment";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const signedBase = verifiedPlivoBase(req.nextUrl.pathname + req.nextUrl.search, formToParams(form), req.headers);
  if (signedBase === null) {
    logger.warn({ path: req.nextUrl.pathname }, "plivo inbound-answer: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }
  const callUUID = form.get("CallUUID") as string | null;
  // Plivo sends bare digits here, not E.164 — normalize so this matches
  // Guest.phone (always `+`-prefixed) for the lookup below.
  const from = normalizeInboundPhone((form.get("From") as string | null) ?? "");

  logger.info({ callUUID }, "plivo inbound-answer webhook");

  // Try to match caller to a guest — also gives us the lead's assigned
  // owner, routing's first priority (see pickRepForCaller).
  const guest = await prisma.guest.findUnique({
    where: { phone: from },
    include: { enquiries: { orderBy: { createdAt: "desc" }, take: 1 } },
  }).catch(() => null);
  const assignedToSub = guest?.enquiries[0]?.assignedToSub ?? null;

  // The matched enquiry may be soft-deleted — revive it rather than
  // silently reattaching this call to a hidden ticket.
  const matchedEnquiry = guest?.enquiries[0];
  if (matchedEnquiry?.deletedAt) await reviveEnquiryIfDeleted(matchedEnquiry.id).catch(() => {});

  // A brand-new caller (no guest on file yet) is exactly the case where
  // inbound-hangup will auto-create a lead — if the admin lead-assignment
  // page has restricted the "call" category to specific staff, only they
  // should be rung, since whoever answers becomes that lead's owner. An
  // existing customer's call keeps routing to their normal owner/sticky rep
  // regardless of this restriction.
  let restrict: CallAssignmentRestriction | undefined;
  if (!guest) {
    const callSettings = await getCallCategoryAssignmentSettings().catch(() => null);
    if (callSettings && callSettings.eligibleSubs.length > 0) {
      restrict = { subs: callSettings.eligibleSubs, strategy: callSettings.strategy };
    }
  }

  // Routing priority: the lead's assigned owner, then sticky (whoever last
  // completed a call with this number), then round-robin — see
  // pickRepForCaller for the full fallback chain.
  const rep = await pickRepForCaller(from, assignedToSub, restrict);
  if (!rep) {
    logger.warn({ callUUID }, "no agents available for inbound call");
    return noAgentXml();
  }

  const call = await prisma.call.create({
    data: {
      direction: "inbound",
      status: "ringing",
      callUUID: callUUID ?? undefined,
      guestId: guest?.id ?? null,
      enquiryId: guest?.enquiries[0]?.id ?? null,
      repKeycloakId: rep.keycloakId,
      repName: rep.displayName,
      repPhone: rep.phone,
      customerPhone: from,
      startedAt: new Date(),
    },
  });

  logger.info({ callId: call.id, repKeycloakId: rep.keycloakId }, "routing inbound to rep");

  // Build call-flow URLs on the origin Plivo actually reached us through,
  // not the configured primary — otherwise a fallback-routed call sends the
  // next hop back to the tunnel that just failed.
  const appUrl = signedBase;
  // `tried` carries the reps already rung across hunt hops (see
  // inbound-hangup) so a no-answer/busy/timeout there rings the next
  // eligible rep instead of ending the call — this rep is "tried" as soon
  // as they're the one being dialed.
  return inboundAnswerXml(
    rep.phone,
    `${appUrl}/api/plivo/inbound-hangup?tried=${encodeURIComponent(rep.keycloakId)}`,
    `${appUrl}/api/plivo/recording-callback?callId=${call.id}`,
  );
}
