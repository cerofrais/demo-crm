import { addDays, addWeeks, isWeekStart, isYmd, istWeekStart, MAX_RANGE_DAYS, rangeDays } from "./cresent-report-shape";

/**
 * Reads the report period from request parameters: either `week` (a Monday)
 * or a custom `from`/`to` (both included). With neither, last week — what the
 * Monday email covers.
 */
export function parseRangeParams(p: { week?: string | null; from?: string | null; to?: string | null }, now = new Date()):
  | { start: string; end: string }
  | { error: string } {
  if (p.from || p.to) {
    if (!p.from || !p.to || !isYmd(p.from) || !isYmd(p.to)) return { error: "Pick both a from and a to date" };
    if (p.from > p.to) return { error: "The from date must be on or before the to date" };
    if (rangeDays(p.from, p.to) > MAX_RANGE_DAYS) return { error: `Pick a range of ${MAX_RANGE_DAYS} days or less` };
    return { start: p.from, end: p.to };
  }
  const week = p.week ?? addWeeks(istWeekStart(now), -1);
  if (!isWeekStart(week)) return { error: "week must be a Monday, YYYY-MM-DD" };
  return { start: week, end: addDays(week, 6) };
}
