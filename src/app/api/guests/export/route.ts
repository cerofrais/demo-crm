/**
 * POST /api/guests/export { guestIds } — the selected guests as a CSV.
 *
 * Built server-side from the guest rows rather than from what the page is
 * holding: the list on screen carries what the list needs to render, and an
 * export wants the things it leaves out — when they came in, when they were
 * last touched, their consent, the lead that belongs to them. Someone opening
 * this in Excel is doing a piece of work the screen could not do for them.
 *
 * A POST rather than a link because the selection can run to thousands of ids,
 * which do not fit in a query string.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireAnyPermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { toCsv } from "@/lib/csv";
import { MAX_BULK_GUESTS } from "@/lib/limits";
import { formatIST } from "@/lib/utils";
import { ageFromDob, ageGroup } from "@/lib/age";
import { sortTags } from "@/lib/lead-tags";
import { stageLabel } from "@/lib/kanban";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  guestIds: z.array(z.string().uuid()).min(1, "Pick at least one guest.").max(MAX_BULK_GUESTS),
});

const HEADERS = [
  "Name",
  "Phone",
  "Email",
  "City",
  "Gender",
  "Age group",
  "Tags",
  "Leads",
  "Latest lead stage",
  "Latest lead owner",
  "Returning",
  "Blocked",
  "Consent given",
  "Health record",
  "Business",
  "Role",
  "First seen",
  "Last activity",
];

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAnyPermission(["guests.view", "health.view"]);
    const { guestIds } = Body.parse(await req.json());

    const guests = await prisma.guest.findMany({
      where: { id: { in: guestIds }, deletedAt: null },
      orderBy: { fullName: "asc" },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        city: true,
        gender: true,
        dateOfBirth: true,
        tags: true,
        isReturning: true,
        isBlocked: true,
        consentGiven: true,
        businessName: true,
        businessRole: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { healthProfiles: true, enquiries: true } },
        enquiries: {
          where: { deletedAt: null },
          orderBy: { lastActivityAt: "desc" },
          take: 1,
          select: { stage: true, assignedToName: true },
        },
      },
    });

    const day = (d: Date) => formatIST(d, { day: "2-digit", month: "short", year: "numeric" });
    const rows = guests.map((g) => {
      const latest = g.enquiries[0];
      return [
        g.fullName,
        // Leading apostrophe: Excel otherwise reads +919812345678 as a formula
        // and shows #NAME?, which is how a phone list becomes useless.
        g.phone ? `'${g.phone}` : "",
        g.email ?? "",
        g.city ?? "",
        g.gender ?? "",
        ageGroup(ageFromDob(g.dateOfBirth)) ?? "",
        sortTags(g.tags).join(", "),
        g._count.enquiries,
        latest ? stageLabel(latest.stage) : "",
        latest?.assignedToName ?? "",
        g.isReturning ? "yes" : "no",
        g.isBlocked ? "yes" : "no",
        g.consentGiven ? "yes" : "no",
        g._count.healthProfiles > 0 ? "yes" : "no",
        g.businessName ?? "",
        g.businessRole ?? "",
        day(g.createdAt),
        day(g.updatedAt),
      ];
    });

    logger.info({ by: ctx.sub, asked: guestIds.length, exported: rows.length }, "guests exported");

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(toCsv(HEADERS, rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="guests-${stamp}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  });
}
