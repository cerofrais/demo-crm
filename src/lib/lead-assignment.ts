import { prisma } from "./prisma";
import { assignNextRep } from "./lead-routing";
import type { LeadAssignmentCategory, LeadAssignmentStrategy } from "@prisma/client";

export type { LeadAssignmentCategory, LeadAssignmentStrategy };

export const LEAD_ASSIGNMENT_CATEGORIES: LeadAssignmentCategory[] = ["whatsapp", "email", "call", "google_sheets"];

export interface LeadAssignmentSettingsDTO {
  category: LeadAssignmentCategory;
  strategy: LeadAssignmentStrategy;
  eligibleSubs: string[];
}

export async function getAllLeadAssignmentSettings(): Promise<LeadAssignmentSettingsDTO[]> {
  const rows = await prisma.leadAssignmentSettings.findMany();
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  return LEAD_ASSIGNMENT_CATEGORIES.map((category) => {
    const row = byCategory.get(category);
    return { category, strategy: row?.strategy ?? "round_robin", eligibleSubs: row?.eligibleSubs ?? [] };
  });
}

export async function setLeadAssignmentSettings(
  category: LeadAssignmentCategory,
  strategy: LeadAssignmentStrategy,
  eligibleSubs: string[],
): Promise<LeadAssignmentSettingsDTO> {
  const row = await prisma.leadAssignmentSettings.upsert({
    where: { category },
    create: { category, strategy, eligibleSubs },
    update: { strategy, eligibleSubs },
  });
  return { category: row.category, strategy: row.strategy, eligibleSubs: row.eligibleSubs };
}

/** Read just the "call" category's settings — consumed by call routing (lib/calls.ts) to
 *  restrict who's rung for a brand-new caller (no existing guest/enquiry yet). */
export async function getCallCategoryAssignmentSettings(): Promise<LeadAssignmentSettingsDTO> {
  const row = await prisma.leadAssignmentSettings.findUnique({ where: { category: "call" } });
  return { category: "call", strategy: row?.strategy ?? "round_robin", eligibleSubs: row?.eligibleSubs ?? [] };
}

interface Candidate {
  keycloakId: string;
  displayName: string;
}

/** Advance a named round-robin cursor (LeadRoutingState.id) over `candidates`, stable order. */
async function roundRobinPick(
  cursorId: string,
  candidates: Candidate[],
): Promise<{ sub: string; name: string }> {
  const ordered = [...candidates].sort((a, b) => a.keycloakId.localeCompare(b.keycloakId));
  const state = await prisma.leadRoutingState.upsert({
    where: { id: cursorId },
    create: { id: cursorId },
    update: {},
  });
  let nextIndex = 0;
  if (state.lastAssignedSub) {
    const lastIndex = ordered.findIndex((r) => r.keycloakId === state.lastAssignedSub);
    nextIndex = lastIndex === -1 ? 0 : (lastIndex + 1) % ordered.length;
  }
  const next = ordered[nextIndex];
  await prisma.leadRoutingState.update({ where: { id: cursorId }, data: { lastAssignedSub: next.keycloakId } });
  return { sub: next.keycloakId, name: next.displayName };
}

const CLOSED_STAGES = ["converted", "lost"];

/** Fewest currently-open (not converted/lost) enquiries assigned — the workload
 *  signal behind every category's "Least busy" strategy for WhatsApp/email. */
async function leastBusyPick(candidates: Candidate[]): Promise<{ sub: string; name: string }> {
  const counts = await prisma.enquiry.groupBy({
    by: ["assignedToSub"],
    where: {
      assignedToSub: { in: candidates.map((c) => c.keycloakId) },
      stage: { notIn: CLOSED_STAGES as never[] },
      deletedAt: null,
    },
    _count: { id: true },
  });
  const countMap = new Map(counts.map((c) => [c.assignedToSub, c._count.id]));
  const picked = candidates.reduce((best, cur) =>
    (countMap.get(cur.keycloakId) ?? 0) < (countMap.get(best.keycloakId) ?? 0) ? cur : best,
  );
  return { sub: picked.keycloakId, name: picked.displayName };
}

/** Shared pool picker — round robin or least-busy-by-open-leads over an
 *  already-filtered candidate list. Used directly by WhatsApp/email
 *  assignment, and by lib/calls.ts for the "round_robin" branch of its own
 *  restricted-pool picking (calls keep their own active-calls-based
 *  least-busy logic — a more relevant signal for a live phone line). */
export async function pickFromEligiblePool(
  cursorId: string,
  strategy: LeadAssignmentStrategy,
  candidates: Candidate[],
): Promise<{ sub: string; name: string } | null> {
  if (!candidates.length) return null;
  return strategy === "round_robin" ? roundRobinPick(cursorId, candidates) : leastBusyPick(candidates);
}

/**
 * Resolve who a freshly auto-created WhatsApp/email/Google Sheets lead
 * should be assigned to. Falls back to the default Sales->Reception round
 * robin (unchanged) when this category has no eligible staff configured, so
 * nothing changes for anyone who hasn't opened the admin page.
 */
export async function pickAssigneeForCategory(
  category: "whatsapp" | "email" | "google_sheets",
): Promise<{ sub: string; name: string } | null> {
  const settings = await prisma.leadAssignmentSettings.findUnique({ where: { category } });
  if (!settings || settings.eligibleSubs.length === 0) {
    return assignNextRep();
  }
  const candidates = await prisma.staffProfile.findMany({
    where: { keycloakId: { in: settings.eligibleSubs } },
    select: { keycloakId: true, displayName: true },
  });
  return pickFromEligiblePool(category, settings.strategy, candidates);
}
