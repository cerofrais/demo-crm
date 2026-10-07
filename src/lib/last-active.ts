/**
 * "Last active" wording for a staff member, from their latest activity-log
 * action. Same 10-minute rule as the activity monitor: an action in the last
 * ten minutes is "Active now".
 */
export type LastActiveState = "now" | "today" | "earlier" | "never";

const IST_OFFSET_MS = 5.5 * 3_600_000;
const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

export function lastActive(iso: string | null | undefined, now = new Date()): { state: LastActiveState; label: string; exact: string | null } {
  if (!iso) return { state: "never", label: "No activity yet", exact: null };
  const at = new Date(iso);
  const exact = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(at);
  const mins = Math.floor((now.getTime() - at.getTime()) / 60_000);
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(at);

  if (mins < 10) return { state: "now", label: "Active now", exact };
  if (mins < 60) return { state: "today", label: `${mins} min ago`, exact };
  if (istDay(at) === istDay(now)) {
    const h = Math.floor(mins / 60);
    return { state: "today", label: `${h}h ago`, exact };
  }
  const yesterday = istDay(new Date(now.getTime() - 86_400_000));
  if (istDay(at) === yesterday) return { state: "earlier", label: `Yesterday, ${time}`, exact };
  if (mins < 7 * 24 * 60) {
    const weekday = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short" }).format(at);
    return { state: "earlier", label: `${weekday}, ${time}`, exact };
  }
  const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(at);
  return { state: "earlier", label: date, exact };
}
