/**
 * Who is actually working today — the single filter every assignment path
 * runs through.
 *
 * Three things can take somebody out of the pool, because they behave
 * differently:
 *   • StaffProfile.weeklyOffDays — a recurring rota ("every Monday"), set
 *     once and self-maintaining.
 *   • StaffLeave — dated ranges for one-off leave, single day or a week.
 *   • StaffShift — working hours per weekday, so a night-shift rep is only in
 *     the pool overnight. No shift rows at all means the whole day, which is
 *     what everyone had before shifts existed.
 *
 * Separate from StaffProfile.isOnline, which stays what it always was: a
 * manual "I'm out right now" switch each person flips in Settings. This
 * module is about PLANNED absence; isOnline covers the unplanned kind, and
 * call routing checks both.
 *
 * There are five places that pick an assignee (the default pool, the
 * per-channel rules, campaign rules, WhatsApp-number rules, and call
 * routing). They all filter through here rather than repeating the rule,
 * because a list duplicated across call sites in this codebase has silently
 * drifted more than once.
 */
import { prisma } from "./prisma";

const IST = "Asia/Kolkata";

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Minutes since midnight IST — the unit shift windows are stored in. */
export function istMinutesOfDay(now: Date = new Date()): number {
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Is `nowMinutes` inside the shift window [start, end)?
 *
 * The case that matters is a night shift, which crosses midnight: 22:00→06:00
 * is start 1320, end 360. Tested naively as `now >= start && now < end` that
 * window is NEVER true, so a night worker would be permanently off duty.
 * When end <= start the window is read as two pieces — from start to
 * midnight, and midnight to end.
 *
 * start === end means a 24-hour shift rather than a zero-length one; a
 * zero-length window is not a thing anyone sets deliberately, and reading it
 * as "never available" would silently remove somebody from routing.
 */
export function isWithinShift(nowMinutes: number, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) return nowMinutes >= startMinute && nowMinutes < endMinute;
  return nowMinutes >= startMinute || nowMinutes < endMinute;
}

/**
 * Today's calendar date and weekday **in IST**, which is the only reading
 * that matches what "Monday off" means to the person taking it.
 *
 * Deriving these from the server's own clock would put the day boundary at
 * 05:30 IST: a Monday off would begin at 05:30 Monday and end at 05:30
 * Tuesday, so Monday's early leads would route to the person who is off and
 * Tuesday's would skip someone who is working. This codebase has been caught
 * by exactly that offset twice, so the timezone is named explicitly rather
 * than inherited.
 */
export function istToday(now: Date = new Date()): { date: string; weekday: number } {
  // en-CA renders ISO-style YYYY-MM-DD, which is also how @db.Date compares.
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const short = new Intl.DateTimeFormat("en-US", { timeZone: IST, weekday: "short" }).format(now);
  return { date, weekday: WEEKDAY_INDEX[short] ?? 0 };
}

/** Does this rota put the person off on `weekday`? */
export function isWeeklyOff(weeklyOffDays: number[] | null | undefined, weekday: number): boolean {
  return (weeklyOffDays ?? []).includes(weekday);
}

/**
 * The subset of `subs` who are NOT off today — the list an assignment picker
 * should choose from.
 *
 * Returns an empty array when everyone is off. Callers must treat that as
 * "nobody to assign to" and leave the lead unassigned rather than falling
 * back to the full pool: assigning to someone on leave puts the lead in a
 * queue nobody is reading, which is worse than it visibly having no owner.
 *
 * An empty `subs` in means an empty array out — never "everybody".
 */
export async function availableSubsToday(subs: string[], now: Date = new Date()): Promise<string[]> {
  if (!subs.length) return [];
  const { date, weekday } = istToday(now);

  const minutesNow = istMinutesOfDay(now);

  const [profiles, onLeave, shifts] = await Promise.all([
    prisma.staffProfile.findMany({
      where: { keycloakId: { in: subs } },
      select: { keycloakId: true, weeklyOffDays: true },
    }),
    prisma.staffLeave.findMany({
      // Inclusive both ends: a single-day leave has startDate == endDate and
      // must match on that day.
      where: { sub: { in: subs }, startDate: { lte: new Date(date) }, endDate: { gte: new Date(date) } },
      select: { sub: true },
    }),
    // A night shift that started YESTERDAY is still running after midnight,
    // so the shift for the previous weekday is fetched too and checked
    // alongside today's — without it, someone on 22:00→06:00 would go
    // unavailable at midnight, exactly halfway through their shift.
    prisma.staffShift.findMany({
      where: { sub: { in: subs }, weekday: { in: [weekday, (weekday + 6) % 7] } },
      select: { sub: true, weekday: true, startMinute: true, endMinute: true },
    }),
  ]);

  const offOnLeave = new Set(onLeave.map((l) => l.sub));
  const rotaBySub = new Map(profiles.map((p) => [p.keycloakId, p.weeklyOffDays]));
  const yesterday = (weekday + 6) % 7;

  return subs.filter((sub) => {
    if (offOnLeave.has(sub)) return false;
    // A sub with no StaffProfile row keeps its place in the pool — it has no
    // rota to be off on, and silently dropping it would change existing
    // routing for anyone whose profile has not synced yet.
    if (isWeeklyOff(rotaBySub.get(sub), weekday)) return false;

    const mine = shifts.filter((sh) => sh.sub === sub);
    // No hours configured means the whole day, which is what everyone had
    // before shifts existed. Only somebody with an explicit window can be
    // off-shift.
    if (!mine.length) return true;

    const today = mine.find((sh) => sh.weekday === weekday);
    if (today && isWithinShift(minutesNow, today.startMinute, today.endMinute)) return true;

    // Still inside last night's shift? Only counts if it actually wrapped
    // past midnight, and only before its end time.
    const last = mine.find((sh) => sh.weekday === yesterday);
    if (last && last.endMinute <= last.startMinute && minutesNow < last.endMinute) {
      // Yesterday must also have been a working day for its shift to be running.
      return !isWeeklyOff(rotaBySub.get(sub), yesterday);
    }
    return false;
  });
}

/** The subset of `subs` who ARE off today — for showing why someone was skipped. */
export async function offSubsToday(subs: string[], now: Date = new Date()): Promise<string[]> {
  const available = new Set(await availableSubsToday(subs, now));
  return subs.filter((s) => !available.has(s));
}
