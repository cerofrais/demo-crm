/**
 * GET /api/health/records — one row per health RECORD, not per guest.
 *
 * The Health Records screen lists records rather than the people they hang
 * off, because those are no longer the same thing: a family shares a phone
 * number and Guest.phone is unique, so three siblings' screening forms all
 * belong to one guest. Listing guests hid two of every three records behind
 * whoever happened to own the number.
 *
 * A row therefore carries its own subject name, and several rows legitimately
 * share a phone. `guestName` is kept alongside so the UI can say whose number
 * a record came in on when the two differ.
 *
 * Read-only and gated on health.view — writing a record is health.edit, over
 * on /api/guests/:id/health.
 */
import { NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX = 200;

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requirePermission("health.view");

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();

    const profiles = await prisma.healthProfile.findMany({
      where: {
        guest: { deletedAt: null },
        ...(q
          ? {
              OR: [
                // The record's own subject first — it is what the row shows,
                // so searching for "Akki" must find Akki's record even though
                // the guest it hangs off is called Nikki.
                { subjectName: { contains: q, mode: "insensitive" } },
                { subjectPhone: { contains: q } },
                { guest: { fullName: { contains: q, mode: "insensitive" } } },
                { guest: { phone: { contains: q } } },
                { guest: { email: { contains: q, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        subjectName: true,
        subjectPhone: true,
        hasDuplicate: true,
        updatedAt: true,
        guest: { select: { id: true, fullName: true, phone: true, dateOfBirth: true } },
      },
      take: MAX,
    });

    const items = profiles.map((p) => ({
      recordId: p.id,
      guestId: p.guest.id,
      // A record with no subject predates per-submission records, or was
      // entered by hand from the guest page — either way it is about the
      // guest themselves.
      name: p.subjectName ?? p.guest.fullName,
      phone: p.subjectPhone ?? p.guest.phone ?? "",
      guestName: p.guest.fullName,
      hasDuplicate: p.hasDuplicate,
      updatedAt: p.updatedAt.toISOString(),
    }));

    // Sorted here rather than in SQL: this database's collation is
    // case-sensitive, which would file every lowercase name after every
    // uppercase one — the same reason the guests list sorts in JS.
    items.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

    return ok({ items, total: items.length });
  });
}
