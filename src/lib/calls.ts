import { prisma } from "./prisma";
import { createEnquiry } from "./enquiry-service";
import { pickFromEligiblePool, type LeadAssignmentStrategy } from "./lead-assignment";
import { logger } from "./logger";
import type { CallDirection, CallStatus, CallRoutingScope, Prisma } from "@prisma/client";
export type { CallRoutingScope };

/** Restricts inbound-call routing to a specific set of staff — set only for
 *  a brand-new caller (no existing guest/enquiry) when the admin lead-
 *  assignment page has configured the "call" category. Existing customers'
 *  calls keep routing to their normal owner/sticky rep regardless. */
export interface CallAssignmentRestriction {
  subs: string[];
  strategy: LeadAssignmentStrategy;
}

/** StaffProfile.role values eligible for inbound routing under each scope. `null` = no filter (any role). */
const ROUTING_SCOPE_ROLES: Record<CallRoutingScope, string[] | null> = {
  reception: ["RECEPTION"],
  sales: ["SALES"],
  reception_sales: ["RECEPTION", "SALES"],
  all: null,
};

export interface CallCoachingDTO {
  hookLine?: string;
  explanation?: string;
  professionalism?: string;
  nextSteps?: string;
}

export interface CallDTO {
  id: string;
  direction: CallDirection;
  status: CallStatus;
  callUUID: string | null;
  guestId: string | null;
  guestName: string | null;
  guestPhone: string | null;
  enquiryId: string | null;
  repKeycloakId: string | null;
  repName: string | null;
  repPhone: string | null;
  customerPhone: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number;
  hasRecording: boolean;
  recordingDurSec: number | null;
  tags: string[];
  notes: string | null;
  transcript: string | null;
  transcriptEnglish: string | null;
  transcriptLanguage: string | null;
  aiSummary: string | null;
  aiScore: number | null;
  aiTags: string[];
  aiSuggestions: CallCoachingDTO | null;
  aiAnalyzedAt: string | null;
}

function toDTO(c: {
  id: string;
  direction: CallDirection;
  status: CallStatus;
  callUUID: string | null;
  guestId: string | null;
  enquiryId: string | null;
  repKeycloakId: string | null;
  repName: string | null;
  repPhone: string | null;
  customerPhone: string;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSec: number;
  recordingUrl: string | null;
  recordingDurSec: number | null;
  tags: string[];
  notes: string | null;
  transcript: string | null;
  transcriptEnglish: string | null;
  transcriptLanguage: string | null;
  aiSummary: string | null;
  aiScore: number | null;
  aiTags: string[];
  aiSuggestions: Prisma.JsonValue;
  aiAnalyzedAt: Date | null;
  guest: { fullName: string; phone: string | null } | null;
}): CallDTO {
  return {
    id: c.id,
    direction: c.direction,
    status: c.status,
    callUUID: c.callUUID,
    guestId: c.guestId,
    guestName: c.guest?.fullName ?? null,
    guestPhone: c.guest?.phone ?? null,
    enquiryId: c.enquiryId,
    repKeycloakId: c.repKeycloakId,
    repName: c.repName,
    repPhone: c.repPhone,
    customerPhone: c.customerPhone,
    startedAt: c.startedAt.toISOString(),
    answeredAt: c.answeredAt?.toISOString() ?? null,
    endedAt: c.endedAt?.toISOString() ?? null,
    durationSec: c.durationSec,
    hasRecording: Boolean(c.recordingUrl),
    recordingDurSec: c.recordingDurSec,
    tags: c.tags,
    notes: c.notes,
    transcript: c.transcript,
    transcriptEnglish: c.transcriptEnglish,
    transcriptLanguage: c.transcriptLanguage,
    aiSummary: c.aiSummary,
    aiScore: c.aiScore,
    aiTags: c.aiTags,
    aiSuggestions: (c.aiSuggestions as CallCoachingDTO | null) ?? null,
    aiAnalyzedAt: c.aiAnalyzedAt?.toISOString() ?? null,
  };
}

const INCLUDE = { guest: { select: { fullName: true, phone: true } } } as const;

// F12: `repKeycloakId` scopes the result to a single rep's calls. Callers that
// can't see all staff (no reports.allStaff) MUST pass their own id here, or a
// RECEPTION user could enumerate every call for any guest/enquiry.
export async function getCallsForGuest(
  guestId: string,
  repKeycloakId?: string,
): Promise<CallDTO[]> {
  const rows = await prisma.call.findMany({
    where: { guestId, ...(repKeycloakId ? { repKeycloakId } : {}) },
    include: INCLUDE,
    orderBy: { startedAt: "desc" },
    take: 50,
  });
  return rows.map(toDTO);
}

export async function getCallsForEnquiry(
  enquiryId: string,
  repKeycloakId?: string,
): Promise<CallDTO[]> {
  const rows = await prisma.call.findMany({
    where: { enquiryId, ...(repKeycloakId ? { repKeycloakId } : {}) },
    include: INCLUDE,
    orderBy: { startedAt: "desc" },
    take: 50,
  });
  return rows.map(toDTO);
}

export interface CallsListFilter {
  direction?: CallDirection;
  status?: CallStatus;
  repKeycloakId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  cursor?: string; // startedAt ISO
  /** Missed/unattended inbound calls from a number with no matching lead yet —
   * the "new caller" tab, distinct from a missed call on an EXISTING lead
   * (which already surfaces via that lead's own Activity log). */
  unattendedOnly?: boolean;
}

const MISSED_STATUSES: CallStatus[] = ["no_answer", "voicemail", "failed"];

export async function listCalls(filter: CallsListFilter, limit = 30): Promise<{ items: CallDTO[]; nextCursor: string | null }> {
  const rows = await prisma.call.findMany({
    where: {
      ...(filter.direction && { direction: filter.direction }),
      ...(filter.status && { status: filter.status }),
      ...(filter.repKeycloakId && { repKeycloakId: filter.repKeycloakId }),
      ...(filter.dateFrom || filter.dateTo
        ? {
            startedAt: {
              ...(filter.dateFrom && { gte: filter.dateFrom }),
              ...(filter.dateTo && { lte: filter.dateTo }),
            },
          }
        : {}),
      ...(filter.cursor && { startedAt: { lt: new Date(filter.cursor) } }),
      ...(filter.unattendedOnly && {
        guestId: null,
        direction: "inbound" as const,
        status: { in: MISSED_STATUSES },
      }),
    },
    include: INCLUDE,
    orderBy: { startedAt: "desc" },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: items.map(toDTO),
    nextCursor: hasMore ? items[items.length - 1].startedAt.toISOString() : null,
  };
}

/** Which staff role(s) are eligible for inbound call routing. */
export async function getCallRoutingSettings(): Promise<{ scope: CallRoutingScope }> {
  const row = await prisma.callRoutingSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  return { scope: row.scope };
}

export async function setCallRoutingSettings(scope: CallRoutingScope): Promise<{ scope: CallRoutingScope }> {
  const row = await prisma.callRoutingSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", scope },
    update: { scope },
  });
  return { scope: row.scope };
}

/** Resolve available rep phone. Default strategy is round-robin by fewest
 *  active calls; when `restrict` narrows the pool with "round_robin"
 *  strategy, cycles through that pool instead via the shared cursor picker.
 *  `excludeSubs` drops specific reps from the pool entirely — used by the
 *  inbound-call hunt (see inbound-hangup route) to ring the next rep rather
 *  than one who already didn't pick up. */
export async function pickAvailableRep(
  restrict?: CallAssignmentRestriction,
  excludeSubs: string[] = [],
): Promise<{ keycloakId: string; displayName: string; phone: string } | null> {
  const { scope } = await getCallRoutingSettings();
  const eligibleRoles = ROUTING_SCOPE_ROLES[scope];
  const profiles = await prisma.staffProfile.findMany({
    where: {
      isOnline: true,
      phone: { not: null },
      ...(eligibleRoles && { role: { in: eligibleRoles } }),
      ...(restrict && { keycloakId: { in: restrict.subs } }),
      ...(excludeSubs.length && { keycloakId: { notIn: excludeSubs } }),
    },
  });
  if (!profiles.length) return null;

  if (restrict?.strategy === "round_robin") {
    const picked = await pickFromEligiblePool("call", "round_robin", profiles);
    const match = picked ? profiles.find((p) => p.keycloakId === picked.sub) : null;
    return match ? { keycloakId: match.keycloakId, displayName: match.displayName, phone: match.phone! } : null;
  }

  // Count active calls per rep
  const activeCounts = await prisma.call.groupBy({
    by: ["repKeycloakId"],
    where: { status: { in: ["ringing", "connected"] }, repKeycloakId: { not: null } },
    _count: { id: true },
  });
  const countMap = new Map(activeCounts.map((r) => [r.repKeycloakId, r._count.id]));

  const picked = profiles.reduce((best, cur) => {
    const bestCount = countMap.get(best.keycloakId) ?? 0;
    const curCount = countMap.get(cur.keycloakId) ?? 0;
    return curCount < bestCount ? cur : best;
  });

  return { keycloakId: picked.keycloakId, displayName: picked.displayName, phone: picked.phone! };
}

/** True if `keycloakId` has no in-progress call right now. */
async function isFree(keycloakId: string): Promise<boolean> {
  const active = await prisma.call.count({
    where: { repKeycloakId: keycloakId, status: { in: ["ringing", "connected"] } },
  });
  return active === 0;
}

/**
 * Routing priority for an inbound call:
 *   1. The lead's CRM-assigned owner (`assignedToSub`), if online, eligible
 *      under the current routing scope, and not already on a call.
 *   2. Sticky routing: whoever last completed a call with this number, same
 *      eligibility check — continuity for the customer, and the rep already
 *      has context.
 *   3. Round-robin across everyone eligible (fewest active calls).
 * Each step falls through to the next when its candidate doesn't qualify
 * (not found, offline, no phone, role outside the current scope, or busy).
 */
export async function pickRepForCaller(
  customerPhone: string,
  assignedToSub?: string | null,
  restrict?: CallAssignmentRestriction,
): Promise<{ keycloakId: string; displayName: string; phone: string } | null> {
  const { scope } = await getCallRoutingSettings();
  const eligibleRoles = ROUTING_SCOPE_ROLES[scope];
  const inScope = (role: string | null) => !eligibleRoles || (role != null && eligibleRoles.includes(role));
  const inRestriction = (sub: string) => !restrict || restrict.subs.includes(sub);

  if (assignedToSub) {
    const owner = await prisma.staffProfile.findUnique({ where: { keycloakId: assignedToSub } });
    if (
      owner?.isOnline &&
      owner.phone &&
      inScope(owner.role) &&
      inRestriction(owner.keycloakId) &&
      (await isFree(owner.keycloakId))
    ) {
      return { keycloakId: owner.keycloakId, displayName: owner.displayName, phone: owner.phone };
    }
  }

  const lastConnected = await prisma.call.findFirst({
    where: {
      customerPhone,
      direction: "inbound",
      status: "completed",
      repKeycloakId: restrict ? { in: restrict.subs } : { not: null },
    },
    orderBy: { startedAt: "desc" },
    select: { repKeycloakId: true },
  });

  if (lastConnected?.repKeycloakId) {
    const rep = await prisma.staffProfile.findUnique({
      where: { keycloakId: lastConnected.repKeycloakId },
    });
    if (rep?.isOnline && rep.phone && inScope(rep.role)) {
      return { keycloakId: rep.keycloakId, displayName: rep.displayName, phone: rep.phone };
    }
  }

  return pickAvailableRep(restrict);
}

/**
 * A completed inbound call from a number with no existing lead becomes a new
 * one, mirroring the WhatsApp/email auto-capture pattern (see
 * resolveGuestByPhone/resolveGuestId) — except the owner isn't round-robin:
 * whoever actually answered the call is a far better-informed pick, so it's
 * assigned straight to them via createEnquiry's assignedTo override.
 */
export async function createLeadFromCall(
  callUUID: string,
  customerPhone: string,
  repKeycloakId: string | null,
  repName: string | null,
): Promise<void> {
  try {
    const result = await createEnquiry({
      fullName: customerPhone,
      phone: customerPhone,
      source: "phone",
      note: "Inbound phone call",
      assignedTo: repKeycloakId && repName ? { sub: repKeycloakId, name: repName } : null,
    });
    await prisma.call.update({
      where: { callUUID },
      data: { guestId: result.enquiry.guest.id, enquiryId: result.enquiry.id },
    });
  } catch (err) {
    logger.error({ err, customerPhone, callUUID }, "call auto-enquiry failed; call left unattached");
  }
}
