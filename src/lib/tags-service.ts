import { prisma } from "./prisma";
import { mergeLeadTags, isSystemTag, slugifyTag } from "./lead-tags";

/**
 * Recompute system tags (age/revisit/source) for an enquiry and persist the
 * merged set (system + existing custom). Called whenever a salesperson touches
 * a lead — create, move, edit — so tags "start saving" automatically.
 * Returns the effective tag list.
 */
export async function syncEnquiryTags(enquiryId: string): Promise<string[]> {
  const e = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    include: { guest: true },
  });
  if (!e) return [];
  const merged = mergeLeadTags(e.tags, e.guest, e);

  const same =
    merged.length === e.tags.length && merged.every((t) => e.tags.includes(t));
  if (!same) {
    await prisma.enquiry.update({ where: { id: enquiryId }, data: { tags: merged } });
  }
  return merged;
}

/**
 * Re-sync every live lead belonging to one guest.
 *
 * Some computed system tags (`age:*`, `foreign`) are derived from the GUEST,
 * not the enquiry — so editing a guest's date of birth or phone silently
 * invalidates the tags stored on their leads. Those
 * leads keep rendering the right tags (toEnquiryDTO merges on read), but the
 * persisted column — which is what tag FILTERS query — falls behind, and the
 * lead stops matching a filter for the tag it visibly carries. Call this
 * wherever guest demographics change.
 */
export async function syncTagsForGuest(guestId: string): Promise<void> {
  const enquiries = await prisma.enquiry.findMany({
    where: { guestId, deletedAt: null },
    select: { id: true },
  });
  for (const e of enquiries) await syncEnquiryTags(e.id);
}

/** Add a custom tag to a lead and register it in the shared vocabulary. */
export async function addCustomTag(
  enquiryId: string,
  raw: string,
  actorSub: string,
): Promise<string[]> {
  const slug = slugifyTag(raw);
  if (!slug) return syncEnquiryTags(enquiryId);

  const e = await prisma.enquiry.findUnique({ where: { id: enquiryId } });
  if (!e) return [];

  const next = Array.from(new Set([...e.tags, slug]));
  await prisma.$transaction([
    prisma.enquiry.update({ where: { id: enquiryId }, data: { tags: next } }),
    prisma.tag.upsert({
      where: { value: slug },
      update: {},
      create: { value: slug, category: "custom", createdBy: actorSub },
    }),
  ]);
  return syncEnquiryTags(enquiryId);
}

/** Remove a tag from a lead. System tags are protected (they recompute). */
export async function removeCustomTag(
  enquiryId: string,
  value: string,
): Promise<string[]> {
  if (isSystemTag(value)) return syncEnquiryTags(enquiryId);
  const e = await prisma.enquiry.findUnique({ where: { id: enquiryId } });
  if (!e) return [];
  await prisma.enquiry.update({
    where: { id: enquiryId },
    data: { tags: e.tags.filter((t) => t !== value) },
  });
  return syncEnquiryTags(enquiryId);
}

/**
 * Add a custom tag directly to a guest and register it in the shared
 * vocabulary. Unlike enquiry tags, guest tags have no system-tag recompute
 * step — a guest isn't staged/sourced, so every guest tag is a plain custom
 * slug (batch-import tags included).
 */
export async function addGuestTag(
  guestId: string,
  raw: string,
  actorSub: string,
): Promise<string[]> {
  const slug = slugifyTag(raw);
  if (!slug) {
    const g = await prisma.guest.findUnique({ where: { id: guestId }, select: { tags: true } });
    return g?.tags ?? [];
  }
  const g = await prisma.guest.findUnique({ where: { id: guestId } });
  if (!g) return [];
  const next = Array.from(new Set([...g.tags, slug]));
  const [updated] = await prisma.$transaction([
    prisma.guest.update({ where: { id: guestId }, data: { tags: next }, select: { tags: true } }),
    prisma.tag.upsert({
      where: { value: slug },
      update: {},
      create: { value: slug, category: "custom", createdBy: actorSub },
    }),
  ]);
  return updated.tags;
}

/**
 * Remove a tag from a guest. A system tag (currently just "blocked") is
 * protected here the same way removeCustomTag protects Enquiry system tags —
 * it can only come off through its own dedicated flow (setGuestBlocked),
 * never a bare tag-removal call, since unblocking also needs to reset
 * isBlocked/blockedAt/blockedBySub, not just the tag.
 */
export async function removeGuestTag(guestId: string, value: string): Promise<string[]> {
  if (isSystemTag(value)) {
    const g = await prisma.guest.findUnique({ where: { id: guestId }, select: { tags: true } });
    return g?.tags ?? [];
  }
  const g = await prisma.guest.findUnique({ where: { id: guestId } });
  if (!g) return [];
  const updated = await prisma.guest.update({
    where: { id: guestId },
    data: { tags: g.tags.filter((t) => t !== value) },
    select: { tags: true },
  });
  return updated.tags;
}

/**
 * Block or unblock a guest — sets isBlocked and keeps the "blocked" system
 * tag in sync (added on block, removed on unblock). Blocking doesn't touch
 * any existing history; it only causes future inbound WhatsApp/email from
 * this guest's phone/address to be silently dropped before being stored —
 * see the whatsapp webhook and inbound-mail handlers.
 */
export async function setGuestBlocked(
  guestId: string,
  blocked: boolean,
  actorSub: string,
): Promise<{ tags: string[]; isBlocked: boolean } | null> {
  const g = await prisma.guest.findUnique({ where: { id: guestId } });
  if (!g) return null;
  const nextTags = blocked
    ? Array.from(new Set([...g.tags, "blocked"]))
    : g.tags.filter((t) => t !== "blocked");
  return prisma.guest.update({
    where: { id: guestId },
    data: {
      isBlocked: blocked,
      blockedAt: blocked ? new Date() : null,
      blockedBySub: blocked ? actorSub : null,
      tags: nextTags,
    },
    select: { tags: true, isBlocked: true },
  });
}
