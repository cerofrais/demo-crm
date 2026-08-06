import { NextRequest } from "next/server";
import { handle, ok, requireSession, requirePermission, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { ageFromDob, ageGroup } from "@/lib/utils";
import { findReturningGuest } from "@/lib/enquiries";
import { createGuestSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// GET /api/guests?q=&gender=&returning=&tags=&skip=&take= — searchable guest
// directory. Paginated 200 at a time by default (skip=200 for the next page,
// skip=400 for the one after, etc.) — `take` can go up to 5000 for "select
// all matching" broadcast targeting (see guest-search.tsx), matching the
// broadcast API's own recipient cap.
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
    const skipRaw = parseInt(sp.get("skip") ?? "0", 10);
    const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? skipRaw : 0;
    const takeRaw = parseInt(sp.get("take") ?? "200", 10);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 5000) : 200;

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
      ...(tags.length ? { tags: { hasEvery: tags } } : {}),
    };

    const [guests, total] = await Promise.all([
      prisma.guest.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take,
        include: { _count: { select: { enquiries: true } }, healthProfile: { select: { id: true } } },
      }),
      prisma.guest.count({ where }),
    ]);

    return ok({
      items: guests.map((g) => ({
        id: g.id,
        fullName: g.fullName,
        phone: g.phone,
        email: g.email,
        city: g.city,
        gender: g.gender,
        ageGroup: ageGroup(ageFromDob(g.dateOfBirth)),
        isReturning: g.isReturning,
        isBlocked: g.isBlocked,
        tags: g.tags,
        enquiryCount: g._count.enquiries,
        hasHealthProfile: Boolean(g.healthProfile),
      })),
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
    const dateOfBirth = input.dateOfBirth ? new Date(input.dateOfBirth) : undefined;

    const existing = await findReturningGuest(phone, email);
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
            gender: existing.gender ?? input.gender,
            dateOfBirth: existing.dateOfBirth ?? dateOfBirth,
          },
          include: { _count: { select: { enquiries: true } }, healthProfile: { select: { id: true } } },
        })
      : await prisma.guest.create({
          data: { fullName: input.fullName.trim(), phone, email, city, gender: input.gender, dateOfBirth },
          include: { _count: { select: { enquiries: true } }, healthProfile: { select: { id: true } } },
        });

    return ok(
      {
        id: guest.id,
        fullName: guest.fullName,
        phone: guest.phone,
        email: guest.email,
        city: guest.city,
        gender: guest.gender,
        ageGroup: ageGroup(ageFromDob(guest.dateOfBirth)),
        isReturning: guest.isReturning,
        isBlocked: guest.isBlocked,
        tags: guest.tags,
        enquiryCount: guest._count.enquiries,
        hasHealthProfile: Boolean(guest.healthProfile),
        alreadyExisted: Boolean(existing),
        nameMismatch,
      },
      undefined,
      existing ? 200 : 201,
    );
  });
}
