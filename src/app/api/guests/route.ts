import { NextRequest } from "next/server";
import { handle, ok, requireSession, requirePermission, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { ageFromDob, ageGroup } from "@/lib/utils";
import { findReturningGuest } from "@/lib/enquiries";
import { latestLeadByGuest } from "@/lib/guest-leads";
import { reviveGuestIfDeleted } from "@/lib/guest-revive";
import { createGuestSchema } from "@/lib/validation";
import type { Prisma } from "@prisma/client";
import { MAX_BULK_GUESTS } from "@/lib/limits";
import { parseTagMatch, tagListFilter } from "@/lib/tag-match";

export const dynamic = "force-dynamic";

// GET /api/guests?q=&gender=&returning=&tags=&skip=&take= — searchable guest
// directory. Paginated 200 at a time by default (skip=200 for the next page,
// skip=400 for the one after, etc.) — `take` can go up to MAX_BULK_GUESTS for
// "select all matching" (see guest-search.tsx), which feeds both broadcast
// targeting and bulk tag removal.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "guests.view") && !can(ctx.roles, "health.view")) {
      throw new ApiError("FORBIDDEN", "No access", 403);
    }
    const sp = req.nextUrl.searchParams;
    const q = sp.get("q")?.trim();
    const gender = sp.get("gender")?.trim();
    const returning = sp.get("returning");
    const tags = sp.get("tags")?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];
    // Guests has always matched ALL selected tags (every other tag filter is
    // "any"), and it feeds bulk delete and broadcast selection — so "all"
    // stays the default here rather than silently widening a selection.
    const tagMatch = parseTagMatch(sp.get("tagMatch"), "all");
    // Mutually exclusive with `tags` by construction — asking for guests that
    // carry tag X AND carry no tags at all can only ever return nothing, so
    // untagged wins rather than silently producing an empty page.
    const untagged = sp.get("untagged") === "true";
    // Opt-in, so the Guests directory is unaffected: it lists everybody and
    // never sends this. Health Records sends it by default, because a guest
    // with no record is nothing to look at on that screen.
    const withHealthRecord = sp.get("withHealthRecord") === "true";
    const skipRaw = parseInt(sp.get("skip") ?? "0", 10);
    const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? skipRaw : 0;
    const takeRaw = parseInt(sp.get("take") ?? "200", 10);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), MAX_BULK_GUESTS) : 200;
    // "recent" (default) keeps the directory ordered by most-recently-touched,
    // which is what you want when working through today's activity. "name"
    // orders A-Z for looking somebody up, or checking a list against another
    // system. Pagination and select-all-matching both send this through, so a
    // page 2 can't arrive under a different order than page 1.
    const sort = sp.get("sort") === "name" ? "name" : "recent";

    // `tags: { has: q }` only matches a tag EQUAL to q — Prisma has no
    // substring match against array elements, so a guest tagged
    // "source:instagram" would never show up for someone typing "instagram".
    // Resolve substring/case-insensitive tag matches separately via raw SQL
    // (parameterized through the tagged template, not string-built) and fold
    // the matching ids into the same OR the other fields already use.
    let tagMatchIds: string[] = [];
    if (q) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Guest"
        WHERE "deletedAt" IS NULL
          AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE ${"%" + q + "%"})
      `;
      tagMatchIds = rows.map((r) => r.id);
    }

    const where = {
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: "insensitive" as const } },
              { phone: { contains: q } },
              { email: { contains: q, mode: "insensitive" as const } },
              { id: { in: tagMatchIds } },
            ],
          }
        : {}),
      ...(gender ? { gender } : {}),
      ...(returning === "true" ? { isReturning: true } : {}),
      ...(untagged
        ? { tags: { isEmpty: true } }
        : tags.length
          ? { tags: tagListFilter(tags, tagMatch) }
          : {}),
      // healthProfile is already joined below for hasHealthProfile, so this
      // narrows the same relation rather than adding a query.
      ...(withHealthRecord ? { healthProfiles: { some: {} } } : {}),
    };

    const include = {
      _count: { select: { enquiries: true } },
      healthProfiles: { select: { id: true } },
    } as const;

    let guests: Prisma.GuestGetPayload<{ include: typeof include }>[];
    let total: number;

    if (sort === "name") {
      // Sorted in JS, not SQL, on purpose. The database collation here is
      // case-sensitive: `ORDER BY "fullName"` puts every lowercase name after
      // Z, so 50 guests (vibeupdigital, vErMadev, trē wellness …) fall off the
      // end of an A-Z list. Prisma has no case-insensitive orderBy, and
      // localeCompare also gets `trē` next to `tre` rather than after `tz`.
      //
      // Paging still has to be correct, so the whole matching set is ordered
      // first and only then sliced — sorting one page at a time would put each
      // page in order but the pages in the wrong order relative to each other.
      // It's two ids-and-names round trips over a few thousand rows, which is
      // cheap; if this table grows past ~100k, move it to a stored
      // lower(fullName) column with an index.
      const ordered = await prisma.guest.findMany({ where, select: { id: true, fullName: true } });
      ordered.sort((a, b) =>
        a.fullName.localeCompare(b.fullName, "en", { sensitivity: "base", numeric: true }),
      );
      total = ordered.length;
      const pageIds = ordered.slice(skip, skip + take).map((g) => g.id);
      const rows = await prisma.guest.findMany({ where: { id: { in: pageIds } }, include });
      const position = new Map(pageIds.map((id, i) => [id, i]));
      guests = rows.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    } else {
      [guests, total] = await Promise.all([
        prisma.guest.findMany({ where, orderBy: { updatedAt: "desc" }, skip, take, include }),
        prisma.guest.count({ where }),
      ]);
    }

    const leads = await latestLeadByGuest(
      guests.filter((g) => g._count.enquiries > 0).map((g) => g.id),
    );

    return ok({
      items: guests.map((g) => {
        const lead = leads.get(g.id);
        return {
          id: g.id,
          fullName: g.fullName,
          phone: g.phone,
          email: g.email,
          city: g.city,
          businessName: g.businessName,
          businessRole: g.businessRole,
          gender: g.gender,
          ageGroup: ageGroup(ageFromDob(g.dateOfBirth)),
          isReturning: g.isReturning,
          isBlocked: g.isBlocked,
          tags: g.tags,
          enquiryCount: g._count.enquiries,
          hasHealthProfile: g.healthProfiles.length > 0,
          latestLeadId: lead?.id ?? null,
          latestLeadDeleted: lead?.deleted ?? false,
        };
      }),
      total,
    });
  });
}

// POST /api/guests — add a guest to the directory directly, with no
// Enquiry/lead ticket attached (unlike the New Lead flow). Deduped by
// phone/email exactly like bulk import: a matching existing guest is
// backfilled where a field is missing, never overwritten or duplicated.
export async function POST(req: NextRequest) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const input = createGuestSchema.parse(await req.json());
    const phone = input.phone?.trim() || undefined;
    const email = input.email?.trim() || undefined;
    const city = input.city?.trim() || undefined;
    const businessName = input.businessName?.trim() || undefined;
    const businessRole = input.businessRole?.trim() || undefined;
    const dateOfBirth = input.dateOfBirth ? new Date(input.dateOfBirth) : undefined;

    // includeDeleted: without it, re-adding a soft-deleted guest by their own
    // phone/email dies on the unique index instead of bringing the record
    // back. `alreadyExisted` in the response tells the UI it was a match.
    const existing = await findReturningGuest(phone, email, { includeDeleted: true });
    if (existing?.deletedAt) {
      await reviveGuestIfDeleted(existing.id, "re-added from the guest directory");
    }
    const nameMismatch = Boolean(
      existing && existing.fullName.trim().toLowerCase() !== input.fullName.trim().toLowerCase(),
    );

    const guest = existing
      ? await prisma.guest.update({
          where: { id: existing.id },
          data: {
            phone: existing.phone ?? phone,
            email: existing.email ?? email,
            city: existing.city ?? city,
            businessName: existing.businessName ?? businessName,
            businessRole: existing.businessRole ?? businessRole,
            gender: existing.gender ?? input.gender,
            dateOfBirth: existing.dateOfBirth ?? dateOfBirth,
          },
          include: { _count: { select: { enquiries: true } }, healthProfiles: { select: { id: true } } },
        })
      : await prisma.guest.create({
          data: { fullName: input.fullName.trim(), phone, email, city, businessName, businessRole, gender: input.gender, dateOfBirth },
          include: { _count: { select: { enquiries: true } }, healthProfiles: { select: { id: true } } },
        });

    // A brand-new guest has no lead; a deduped existing one may well have.
    const lead = guest._count.enquiries > 0
      ? (await latestLeadByGuest([guest.id])).get(guest.id)
      : undefined;

    return ok(
      {
        id: guest.id,
        fullName: guest.fullName,
        phone: guest.phone,
        email: guest.email,
        city: guest.city,
        businessName: guest.businessName,
        businessRole: guest.businessRole,
        gender: guest.gender,
        ageGroup: ageGroup(ageFromDob(guest.dateOfBirth)),
        isReturning: guest.isReturning,
        isBlocked: guest.isBlocked,
        tags: guest.tags,
        enquiryCount: guest._count.enquiries,
        hasHealthProfile: guest.healthProfiles.length > 0,
        latestLeadId: lead?.id ?? null,
        latestLeadDeleted: lead?.deleted ?? false,
        alreadyExisted: Boolean(existing),
        nameMismatch,
      },
      undefined,
      existing ? 200 : 201,
    );
  });
}
