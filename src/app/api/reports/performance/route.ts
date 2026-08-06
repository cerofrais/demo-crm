import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { resolveReportRange } from "@/lib/report-range";

export const dynamic = "force-dynamic";

/**
 * Front-office performance, computed on-read from the Activity log (spec §6.4).
 * Managers/Admins see every staff member; Reception sees only their own row.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.own")) {
      throw new ApiError("FORBIDDEN", "No access to reports", 403);
    }
    const seeAll = can(ctx.roles, "reports.allStaff");
    const { start, end, period } = resolveReportRange(req.nextUrl.searchParams);

    const actorFilter = seeAll ? {} : { actorSub: ctx.sub };

    // Optional cross-cutting filters (campaign / source) — narrow which
    // enquiries' activity counts toward each staff member's row, e.g.
    // "how did everyone do on Instagram leads this month".
    const source = req.nextUrl.searchParams.get("source") || undefined;
    const campaignLabel = req.nextUrl.searchParams.get("campaignLabel")?.trim() || undefined;
    const enquiryFilter = {
      ...(source && { source: source as Prisma.EnquiryWhereInput["source"] }),
      ...(campaignLabel && { campaignLabel: { contains: campaignLabel, mode: "insensitive" as const } }),
    };
    const hasEnquiryFilter = Object.keys(enquiryFilter).length > 0;

    // Excludes every automated/system-logged Activity, not just the literal
    // "system" actorSub — background jobs also log under actorSub values like
    // "whatsapp-mobile" (a rep texting from their own phone, synced back for
    // the audit trail) and "plivo-missed-call", which all set actorRole:
    // "system" (vs. a real ctx.roles[0] for anything a staff member did).
    // Filtering on actorSub alone let those slip through as phantom
    // all-zero "staff" rows — e.g. a "WhatsApp mobile app" row that isn't a
    // person at all.
    const notSystem = { actorRole: { not: "system" } };

    const [byType, names, conversions, currentStaff] = await Promise.all([
      prisma.activity.groupBy({
        by: ["actorSub", "actionType"],
        where: {
          createdAt: { gte: start, lte: end },
          ...notSystem,
          ...actorFilter,
          ...(hasEnquiryFilter && { enquiry: enquiryFilter }),
        },
        _count: true,
      }),
      prisma.activity.findMany({
        where: { ...notSystem, ...actorFilter },
        distinct: ["actorSub"],
        orderBy: { createdAt: "desc" },
        select: { actorSub: true, actorName: true },
      }),
      prisma.enquiry.groupBy({
        by: ["assignedToSub"],
        where: {
          deletedAt: null,
          stage: { in: ["booking_confirmed", "converted"] },
          assignedToSub: seeAll ? { not: null } : ctx.sub,
          ...enquiryFilter,
        },
        _count: true,
      }),
      // A departed/removed staff member's historical Activity rows never go
      // away, but they shouldn't keep generating a row here forever — cross-
      // check against who's actually still a staff member (found via a real
      // case: a seed-only "seed-reception" actor, cleaned up as a
      // StaffProfile back on 2026-07-22, kept appearing under its old
      // snapshotted name because nothing here ever re-checked that).
      prisma.staffProfile.findMany({ select: { keycloakId: true } }),
    ]);

    const currentSubs = new Set(currentStaff.map((s) => s.keycloakId));
    const nameMap = new Map(
      names.filter((n) => currentSubs.has(n.actorSub)).map((n) => [n.actorSub, n.actorName ?? "Unknown"]),
    );
    const convMap = new Map(
      conversions.map((c) => [c.assignedToSub as string, c._count]),
    );

    const subs = Array.from(nameMap.keys());
    const metric = (sub: string, type: string) =>
      byType.find((b) => b.actorSub === sub && b.actionType === type)?._count ?? 0;

    const rows = subs
      .map((sub) => ({
        sub,
        name: nameMap.get(sub) ?? "Unknown",
        leadsCreated: metric(sub, "created"),
        stageChanges: metric(sub, "stage_change"),
        notes: metric(sub, "note"),
        messages: metric(sub, "message_sent"),
        docsUploaded: metric(sub, "doc_upload"),
        conversions: convMap.get(sub) ?? 0,
      }))
      .sort((a, b) => b.conversions - a.conversions || b.stageChanges - a.stageChanges);

    return ok(rows, { period, startDate: start.toISOString(), endDate: end.toISOString() });
  });
}
