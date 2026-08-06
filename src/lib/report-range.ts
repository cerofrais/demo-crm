/**
 * Shared date-range resolution for the Reports tab's API routes — the
 * Performance table and the Source × stage matrix both filter on the same
 * period/custom-range picker, so they need identical resolution logic.
 */
export interface ReportRange {
  start: Date;
  end: Date;
  /** Resolved label — "custom" whenever a valid startDate/endDate pair was
   *  given, even if the caller also passed a `period`. */
  period: string;
}

/** A custom range (both dates present and valid) always wins over `period`. */
export function resolveReportRange(searchParams: URLSearchParams): ReportRange {
  const rawStart = searchParams.get("startDate");
  const rawEnd = searchParams.get("endDate");
  const customStart = rawStart ? new Date(rawStart) : null;
  const customEnd = rawEnd ? new Date(rawEnd) : null;
  const hasCustomRange =
    !!customStart && !!customEnd && !isNaN(customStart.getTime()) && !isNaN(customEnd.getTime());

  const period = searchParams.get("period") ?? "week";
  let start: Date;
  let end = new Date();
  if (hasCustomRange) {
    start = customStart!;
    end = customEnd!;
  } else {
    start = new Date();
    if (period === "day") start.setDate(start.getDate() - 1);
    else if (period === "week") start.setDate(start.getDate() - 7);
    else if (period === "month") start.setMonth(start.getMonth() - 1);
    else start.setFullYear(start.getFullYear() - 50); // "all"
  }
  return { start, end, period: hasCustomRange ? "custom" : period };
}
