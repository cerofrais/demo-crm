/**
 * GET  /api/admin/staff-availability — every lead-working staff member with
 *      their weekly rota, their upcoming leave, and whether they are off today.
 * PUT  /api/admin/staff-availability — set one person's weekly rota.
 * POST /api/admin/staff-availability — add a dated leave.
 * DELETE /api/admin/staff-availability?leaveId=… — remove one.
 *
 * Admin/Manager only. Being off takes someone out of the round robin for
 * leads AND out of inbound call routing, so this is a scheduling decision
 * rather than something a person opts into for themselves.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { istToday, isWeeklyOff, istMinutesOfDay, isWithinShift } from "@/lib/staff-availability";

export const dynamic = "force-dynamic";

/** The roles that get leads or calls routed to them — nobody else has a rota. */
const ROUTED_ROLES = ["SALES", "RECEPTION", "MANAGER", "ADMIN"];

const rotaSchema = z.object({
  sub: z.string().min(1),
  // 0 = Sunday … 6 = Saturday. Bounded so a stray value can't sit in the
  // array forever matching nothing.
  weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(7),
});

/** "HH:MM" -> minutes from midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function toHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const shiftSchema = z.object({
  sub: z.string().min(1),
  weekday: z.number().int().min(0).max(6),
  // null clears the shift for that day, which means "works the whole day"
  // rather than "off" — being off is the rota's job, not this one.
  start: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  end: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
});

const leaveSchema = z
  .object({
    sub: z.string().min(1),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
    note: z.string().max(200).optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "endDate cannot be before startDate",
    path: ["endDate"],
  });

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "lead-assignment.view"]);
    const { date, weekday } = istToday();

    const minutesNow = istMinutesOfDay();
    const [staff, leave, shifts] = await Promise.all([
      prisma.staffProfile.findMany({
        where: { role: { in: ROUTED_ROLES } },
        orderBy: { displayName: "asc" },
        select: { keycloakId: true, displayName: true, role: true, isOnline: true, weeklyOffDays: true },
      }),
      // Today and forward only — past leave is history, not scheduling.
      prisma.staffLeave.findMany({
        where: { endDate: { gte: new Date(date) } },
        orderBy: { startDate: "asc" },
      }),
      prisma.staffShift.findMany({ orderBy: { weekday: "asc" } }),
    ]);

    const shiftsBySub = new Map<string, typeof shifts>();
    for (const sh of shifts) shiftsBySub.set(sh.sub, [...(shiftsBySub.get(sh.sub) ?? []), sh]);

    const leaveBySub = new Map<string, typeof leave>();
    for (const l of leave) leaveBySub.set(l.sub, [...(leaveBySub.get(l.sub) ?? []), l]);

    return ok({
      today: { date, weekday },
      staff: staff.map((s) => {
        const mine = leaveBySub.get(s.keycloakId) ?? [];
        const onLeaveToday = mine.some(
          (l) => l.startDate.toISOString().slice(0, 10) <= date && l.endDate.toISOString().slice(0, 10) >= date,
        );
        const myShifts = shiftsBySub.get(s.keycloakId) ?? [];
        const todayShift = myShifts.find((sh) => sh.weekday === weekday);
        const offToday = onLeaveToday || isWeeklyOff(s.weeklyOffDays, weekday);
        return {
          sub: s.keycloakId,
          name: s.displayName,
          role: s.role,
          isOnline: s.isOnline,
          weeklyOffDays: s.weeklyOffDays,
          shifts: myShifts.map((sh) => ({
            weekday: sh.weekday,
            start: toHHMM(sh.startMinute),
            end: toHHMM(sh.endMinute),
          })),
          // Only meaningful when they are not off today at all. A day with no
          // shift row is the whole day, matching the routing rule.
          onShiftNow:
            !offToday &&
            (!todayShift || isWithinShift(minutesNow, todayShift.startMinute, todayShift.endMinute)),
          offToday,
          onLeaveToday,
          leave: mine.map((l) => ({
            id: l.id,
            startDate: l.startDate.toISOString().slice(0, 10),
            endDate: l.endDate.toISOString().slice(0, 10),
            note: l.note,
          })),
        };
      }),
    });
  });
}

export async function PUT(req: NextRequest) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const { sub, weeklyOffDays } = rotaSchema.parse(await req.json());
    // Deduped and sorted so the stored array reads the same however it was
    // clicked, and a repeated day can't make the column grow.
    const days = Array.from(new Set(weeklyOffDays)).sort((a, b) => a - b);
    const updated = await prisma.staffProfile.update({
      where: { keycloakId: sub },
      data: { weeklyOffDays: days },
      select: { keycloakId: true, weeklyOffDays: true },
    });
    return ok({ sub: updated.keycloakId, weeklyOffDays: updated.weeklyOffDays });
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    const { sub, startDate, endDate, note } = leaveSchema.parse(await req.json());
    const row = await prisma.staffLeave.create({
      data: {
        sub,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        note: note?.trim() || null,
        createdBy: ctx.sub,
      },
    });
    return ok({ id: row.id }, undefined, 201);
  });
}

export async function DELETE(req: NextRequest) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const leaveId = req.nextUrl.searchParams.get("leaveId");
    if (!leaveId) throw new ApiError("BAD_REQUEST", "leaveId is required", 400);
    await prisma.staffLeave.deleteMany({ where: { id: leaveId } });
    return ok({ id: leaveId, deleted: true });
  });
}

/**
 * PATCH /api/admin/staff-availability — set or clear one weekday's hours.
 *
 * Clearing (null start/end) removes the row, which means "works the whole
 * day" — the same state as somebody who has never had hours set. Marking a
 * day off is the rota's job, not this one, so there is no way to express
 * "off" here and no risk of the two disagreeing.
 */
export async function PATCH(req: NextRequest) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const { sub, weekday, start, end } = shiftSchema.parse(await req.json());

    if (!start || !end) {
      await prisma.staffShift.deleteMany({ where: { sub, weekday } });
      return ok({ sub, weekday, start: null, end: null });
    }

    const startMinute = toMinutes(start);
    const endMinute = toMinutes(end);
    await prisma.staffShift.upsert({
      where: { sub_weekday: { sub, weekday } },
      create: { sub, weekday, startMinute, endMinute },
      update: { startMinute, endMinute },
    });
    return ok({ sub, weekday, start, end });
  });
}
