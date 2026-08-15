import { prisma } from "@/lib/prisma";

export interface GuestLeadPointer {
  id: string;
  /** True when the only lead left for this guest is soft-deleted. */
  deleted: boolean;
}

/**
 * Newest lead per guest, so the Guests directory can link a guest straight to
 * their lead card. Prefers a LIVE lead; falls back to a soft-deleted one so a
 * guest whose lead was removed still opens onto their history (in the
 * admin-only Deleted Leads archive) rather than the click dead-ending.
 *
 * Two scoped queries rather than including the whole relation on the guest
 * read: at take=5000 (the "select all matching" broadcast path) inlining every
 * enquiry would pull tens of thousands of rows nobody reads. `distinct` over a
 * guestId-first orderBy keeps the first row per guest — i.e. the newest.
 */
export async function latestLeadByGuest(
  guestIds: string[],
): Promise<Map<string, GuestLeadPointer>> {
  const out = new Map<string, GuestLeadPointer>();
  if (!guestIds.length) return out;

  const live = await prisma.enquiry.findMany({
    where: { guestId: { in: guestIds }, deletedAt: null },
    select: { id: true, guestId: true },
    orderBy: [{ guestId: "asc" }, { createdAt: "desc" }],
    distinct: ["guestId"],
  });
  for (const e of live) out.set(e.guestId, { id: e.id, deleted: false });

  // Only guests with no live lead need the archive lookup — usually a handful.
  const remaining = guestIds.filter((id) => !out.has(id));
  if (remaining.length) {
    const archived = await prisma.enquiry.findMany({
      where: { guestId: { in: remaining }, deletedAt: { not: null } },
      select: { id: true, guestId: true },
      orderBy: [{ guestId: "asc" }, { deletedAt: "desc" }],
      distinct: ["guestId"],
    });
    for (const e of archived) out.set(e.guestId, { id: e.id, deleted: true });
  }

  return out;
}
