import { prisma } from "./prisma";
import { assignNextRep } from "./lead-routing";
import { slugifyTag } from "./lead-tags";
import { availableSubsToday } from "./staff-availability";
import type { LeadAssignmentCategory, LeadAssignmentStrategy } from "@prisma/client";

export type { LeadAssignmentCategory, LeadAssignmentStrategy };

export const LEAD_ASSIGNMENT_CATEGORIES: LeadAssignmentCategory[] = [
  "whatsapp",
  "email",
  "call",
  "google_sheets",
  "website_form",
  "instagram",
  "facebook",
  "medical_form",
];

/**
 * Pre-arrival forms. Not a lead source and not routed like one: the form
 * arrives by email, so without its own rule it inherits the Incoming Email
 * pool — which is how every pre-arrival form ended up with the one person in
 * that pool while Front Office, who actually handle the arrival, saw none of
 * them.
 */
export const MEDICAL_FORM_CATEGORY = "medical_form" as const;

/**
 * The categories whose name IS the Enquiry.source that routes to them, i.e.
 * everything except `call` (which is routed by who answers the phone, not by
 * an enquiry source). resolveAutoAssignee keys off this, so adding a value to
 * the enum is all it takes for that channel to become configurable — the old
 * hardcoded `source === "whatsapp" || ...` check left website-form, Instagram
 * and Facebook leads falling through to the all-Sales default pool with no
 * way for an admin to narrow them.
 */
export const SOURCE_ROUTED_CATEGORIES = LEAD_ASSIGNMENT_CATEGORIES.filter(
  (c) => c !== "call" && c !== MEDICAL_FORM_CATEGORY,
);

/** Does this Enquiry.source have its own assignment settings? */
export function isSourceRouted(source: string): source is SourceRoutedCategory {
  return (SOURCE_ROUTED_CATEGORIES as string[]).includes(source);
}

export type SourceRoutedCategory = Exclude<LeadAssignmentCategory, "call">;

export interface LeadAssignmentSettingsDTO {
  category: LeadAssignmentCategory;
  strategy: LeadAssignmentStrategy;
  eligibleSubs: string[];
  /** Pre-arrival forms only: whether a form hands over a lead that already
   *  has an owner. Ignored by every other category. */
  reassignExisting: boolean;
}

export async function getAllLeadAssignmentSettings(): Promise<LeadAssignmentSettingsDTO[]> {
  const rows = await prisma.leadAssignmentSettings.findMany();
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  return LEAD_ASSIGNMENT_CATEGORIES.map((category) => {
    const row = byCategory.get(category);
    return {
      category,
      strategy: row?.strategy ?? "round_robin",
      eligibleSubs: row?.eligibleSubs ?? [],
      reassignExisting: row?.reassignExisting ?? false,
    };
  });
}

export async function setLeadAssignmentSettings(
  category: LeadAssignmentCategory,
  strategy: LeadAssignmentStrategy,
  eligibleSubs: string[],
  reassignExisting = false,
): Promise<LeadAssignmentSettingsDTO> {
  const row = await prisma.leadAssignmentSettings.upsert({
    where: { category },
    create: { category, strategy, eligibleSubs, reassignExisting },
    update: { strategy, eligibleSubs, reassignExisting },
  });
  return {
    category: row.category,
    strategy: row.strategy,
    eligibleSubs: row.eligibleSubs,
    reassignExisting: row.reassignExisting,
  };
}

/** Read just the "call" category's settings — consumed by call routing (lib/calls.ts) to
 *  restrict who's rung for a brand-new caller (no existing guest/enquiry yet). */
export async function getCallCategoryAssignmentSettings(): Promise<LeadAssignmentSettingsDTO> {
  const row = await prisma.leadAssignmentSettings.findUnique({ where: { category: "call" } });
  return {
    category: "call",
    strategy: row?.strategy ?? "round_robin",
    eligibleSubs: row?.eligibleSubs ?? [],
    reassignExisting: false,
  };
}

export interface CampaignAssignmentRuleDTO {
  campaignSlug: string;
  campaignLabel: string;
  strategy: LeadAssignmentStrategy;
  eligibleSubs: string[];
}

export async function getAllCampaignAssignmentRules(): Promise<CampaignAssignmentRuleDTO[]> {
  const rows = await prisma.campaignAssignmentRule.findMany({ orderBy: { campaignLabel: "asc" } });
  return rows.map((r) => ({
    campaignSlug: r.campaignSlug,
    campaignLabel: r.campaignLabel,
    strategy: r.strategy,
    eligibleSubs: r.eligibleSubs,
  }));
}

/**
 * Create/update a campaign's assignment rule, or remove it when
 * `eligibleSubs` is cleared back to empty — unlike the four fixed channel
 * rows in LeadAssignmentSettings, campaign rules are a growable, admin-typed
 * list, so an emptied-out rule is deleted rather than left behind as a
 * do-nothing row that would otherwise accumulate from experimentation.
 */
export async function setCampaignAssignmentRule(
  campaignLabel: string,
  strategy: LeadAssignmentStrategy,
  eligibleSubs: string[],
): Promise<CampaignAssignmentRuleDTO | null> {
  const campaignSlug = slugifyTag(campaignLabel);
  if (!campaignSlug) return null;

  if (eligibleSubs.length === 0) {
    await prisma.campaignAssignmentRule.deleteMany({ where: { campaignSlug } });
    return null;
  }

  const row = await prisma.campaignAssignmentRule.upsert({
    where: { campaignSlug },
    create: { campaignSlug, campaignLabel, strategy, eligibleSubs },
    update: { strategy, eligibleSubs },
  });
  return {
    campaignSlug: row.campaignSlug,
    campaignLabel: row.campaignLabel,
    strategy: row.strategy,
    eligibleSubs: row.eligibleSubs,
  };
}

export async function deleteCampaignAssignmentRule(campaignSlug: string): Promise<void> {
  await prisma.campaignAssignmentRule.deleteMany({ where: { campaignSlug } });
}

export interface TagAssignmentRuleDTO {
  tag: string;
  label: string;
  strategy: LeadAssignmentStrategy;
  eligibleSubs: string[];
  priority: number;
}

export async function getAllTagAssignmentRules(): Promise<TagAssignmentRuleDTO[]> {
  const rows = await prisma.tagAssignmentRule.findMany({
    orderBy: [{ priority: "asc" }, { label: "asc" }],
  });
  return rows.map((r) => ({
    tag: r.tag,
    label: r.label,
    strategy: r.strategy,
    eligibleSubs: r.eligibleSubs,
    priority: r.priority,
  }));
}

/**
 * Create/update a tag rule, or delete it when the pool is emptied — the same
 * lifecycle as campaign and number rules, and for the same reason: an empty
 * rule is indistinguishable from no rule, so keeping the row would only
 * accumulate dead config.
 */
export async function setTagAssignmentRule(
  label: string,
  strategy: LeadAssignmentStrategy,
  eligibleSubs: string[],
  priority = 0,
): Promise<TagAssignmentRuleDTO | null> {
  const tag = slugifyTag(label);
  if (!tag) return null;

  if (eligibleSubs.length === 0) {
    await prisma.tagAssignmentRule.deleteMany({ where: { tag } });
    return null;
  }

  const row = await prisma.tagAssignmentRule.upsert({
    where: { tag },
    create: { tag, label, strategy, eligibleSubs, priority },
    update: { label, strategy, eligibleSubs, priority },
  });
  return {
    tag: row.tag,
    label: row.label,
    strategy: row.strategy,
    eligibleSubs: row.eligibleSubs,
    priority: row.priority,
  };
}

export async function deleteTagAssignmentRule(tag: string): Promise<void> {
  const slug = slugifyTag(tag);
  if (!slug) return;
  await prisma.tagAssignmentRule.deleteMany({ where: { tag: slug } });
}

export interface WhatsAppNumberAssignmentRuleDTO {
  ourNumber: string;
  label: string;
  strategy: LeadAssignmentStrategy;
  eligibleSubs: string[];
}

export async function getAllWhatsAppNumberAssignmentRules(): Promise<WhatsAppNumberAssignmentRuleDTO[]> {
  const rows = await prisma.whatsAppNumberAssignmentRule.findMany({ orderBy: { label: "asc" } });
  return rows.map((r) => ({
    ourNumber: r.ourNumber,
    label: r.label,
    strategy: r.strategy,
    eligibleSubs: r.eligibleSubs,
  }));
}

/**
 * Create/update the rule for one of our WhatsApp numbers, or remove it when
 * `eligibleSubs` is cleared back to empty — same lifecycle as a campaign
 * rule, and for the same reason: an emptied-out rule is indistinguishable
 * from no rule, so leaving the row behind just accumulates dead config.
 */
export async function setWhatsAppNumberAssignmentRule(
  ourNumber: string,
  label: string,
  strategy: LeadAssignmentStrategy,
  eligibleSubs: string[],
): Promise<WhatsAppNumberAssignmentRuleDTO | null> {
  const key = normalizeOurNumber(ourNumber);
  if (!key) return null;

  if (eligibleSubs.length === 0) {
    await prisma.whatsAppNumberAssignmentRule.deleteMany({ where: { ourNumber: key } });
    return null;
  }

  const row = await prisma.whatsAppNumberAssignmentRule.upsert({
    where: { ourNumber: key },
    create: { ourNumber: key, label, strategy, eligibleSubs },
    update: { label, strategy, eligibleSubs },
  });
  return {
    ourNumber: row.ourNumber,
    label: row.label,
    strategy: row.strategy,
    eligibleSubs: row.eligibleSubs,
  };
}

export async function deleteWhatsAppNumberAssignmentRule(ourNumber: string): Promise<void> {
  const key = normalizeOurNumber(ourNumber);
  if (!key) return;
  await prisma.whatsAppNumberAssignmentRule.deleteMany({ where: { ourNumber: key } });
}

/**
 * E.164 with the leading "+", which is how Guest.phone and
 * WhatsAppNumber.phoneNumber are both stored. Normalised on the way in and
 * on the way out so a rule saved as "918712623061" still matches an inbound
 * message that reports "+918712623061" — otherwise the rule silently never
 * fires, which is the worst possible failure for routing config.
 */
export function normalizeOurNumber(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

/**
 * Resolve who a lead opened by an inbound WhatsApp message should go to,
 * based on which of our numbers received it. Checked BEFORE the campaign and
 * channel rules: which line a guest wrote to is the most concrete routing
 * fact available at that moment — one number may be the doctor's, another
 * the sales line — whereas "source: whatsapp" says only that it arrived on
 * WhatsApp at all.
 *
 * Returns null when this number has no rule, so the caller falls through to
 * the campaign rule and then the per-channel default exactly as before.
 */
export async function pickAssigneeForWhatsAppNumber(
  ourNumber: string | null | undefined,
): Promise<{ sub: string; name: string } | null> {
  const key = normalizeOurNumber(ourNumber);
  if (!key) return null;

  const rule = await prisma.whatsAppNumberAssignmentRule.findUnique({ where: { ourNumber: key } });
  if (!rule || rule.eligibleSubs.length === 0) return null;

  const candidates = await prisma.staffProfile.findMany({
    where: { keycloakId: { in: rule.eligibleSubs } },
    select: { keycloakId: true, displayName: true },
  });
  return pickFromEligiblePool(`whatsapp-number:${key}`, rule.strategy, candidates);
}

/**
 * Resolve who a freshly auto-created lead should go to based on its
 * campaign, checked BEFORE the per-channel category (see
 * pickAssigneeForCategory) — a campaign is more specific targeting than a
 * generic channel, so it wins when both are configured. Returns null (no
 * campaign rule configured, or none for this campaign) so the caller falls
 * through to channel-based/default assignment.
 */
export async function pickAssigneeForCampaign(
  campaignLabel: string | null | undefined,
): Promise<{ sub: string; name: string } | null> {
  if (!campaignLabel) return null;
  const campaignSlug = slugifyTag(campaignLabel);
  if (!campaignSlug) return null;

  const rule = await prisma.campaignAssignmentRule.findUnique({ where: { campaignSlug } });
  if (!rule || rule.eligibleSubs.length === 0) return null;

  const candidates = await prisma.staffProfile.findMany({
    where: { keycloakId: { in: rule.eligibleSubs } },
    select: { keycloakId: true, displayName: true },
  });
  return pickFromEligiblePool(`campaign:${campaignSlug}`, rule.strategy, candidates);
}

/**
 * Route by a tag the lead carries at creation — including the system tags
 * computed from the lead itself, which is what makes a rule on "foreign"
 * (a non-Indian phone number) work at all.
 *
 * A lead can hold several tags, so "which rule wins" has to be decided
 * rather than left to chance: rules are tried by `priority` (lower first),
 * then by tag, and the first one with somebody actually available takes it.
 * Falling through a rule whose whole pool is off today is deliberate — the
 * next rule is a better answer than nobody.
 */
export async function pickAssigneeForTags(
  tags: string[] | null | undefined,
): Promise<{ sub: string; name: string } | null> {
  if (!tags?.length) return null;
  const slugs = [...new Set(tags.map((t) => slugifyTag(t)).filter(Boolean))];
  if (!slugs.length) return null;

  const rules = await prisma.tagAssignmentRule.findMany({
    where: { tag: { in: slugs } },
    orderBy: [{ priority: "asc" }, { tag: "asc" }],
  });

  for (const rule of rules) {
    if (!rule.eligibleSubs.length) continue;
    const candidates = await prisma.staffProfile.findMany({
      where: { keycloakId: { in: rule.eligibleSubs } },
      select: { keycloakId: true, displayName: true },
    });
    const picked = await pickFromEligiblePool(`tag:${rule.tag}`, rule.strategy, candidates);
    if (picked) return picked;
  }
  return null;
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

const CLOSED_STAGES = ["converted", "lost", "non_leads"];

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

  // Anyone on a rota day off, or on dated leave, drops out of the pool for
  // today — including out of the round-robin cursor, so the rotation simply
  // skips them rather than parking a lead in an unread queue.
  //
  // Returning null when everyone is off is deliberate: the caller leaves the
  // lead unassigned. An unowned lead is visible as unowned; one assigned to
  // somebody on leave looks handled and isn't.
  const availableSubs = new Set(await availableSubsToday(candidates.map((c) => c.keycloakId)));
  const working = candidates.filter((c) => availableSubs.has(c.keycloakId));
  if (!working.length) return null;

  return strategy === "round_robin" ? roundRobinPick(cursorId, working) : leastBusyPick(working);
}

/**
 * Resolve who a freshly auto-created WhatsApp/email/Google Sheets lead
 * should be assigned to. Falls back to the default Sales->Reception round
 * robin (unchanged) when this category has no eligible staff configured, so
 * nothing changes for anyone who hasn't opened the admin page.
 */
export interface MedicalFormRouting {
  /** Who the form's lead should go to, or null when nobody is configured. */
  assignee: { sub: string; name: string } | null;
  /** Whether a form for a lead that already has an owner hands it over. */
  reassignExisting: boolean;
}

/**
 * Where a pre-arrival form's lead belongs.
 *
 * Returns no assignee when the rule is unset, and the caller then leaves
 * ownership exactly as it was — an unconfigured rule must not change how
 * anything behaves today.
 */
export async function routeMedicalForm(): Promise<MedicalFormRouting> {
  const settings = await prisma.leadAssignmentSettings.findUnique({
    where: { category: MEDICAL_FORM_CATEGORY },
  });
  if (!settings || settings.eligibleSubs.length === 0) {
    return { assignee: null, reassignExisting: false };
  }
  const candidates = await prisma.staffProfile.findMany({
    where: { keycloakId: { in: settings.eligibleSubs } },
    select: { keycloakId: true, displayName: true },
  });
  const assignee = await pickFromEligiblePool(
    MEDICAL_FORM_CATEGORY,
    settings.strategy,
    candidates,
  );
  return { assignee, reassignExisting: settings.reassignExisting };
}

export async function pickAssigneeForCategory(
  category: SourceRoutedCategory,
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
