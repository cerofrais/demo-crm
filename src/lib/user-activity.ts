/**
 * Activity monitor — how active each staff member was through one IST day,
 * read from the activity log in 10-minute slots.
 *
 * Two readings of the same slots: the COUNT of actions in each (how busy),
 * and ACTIVE/INACTIVE (anything at all in those ten minutes, or nothing).
 *
 * What it can and can't see: only what writes an activity-log row — remarks,
 * stage moves, messages sent, calls, tasks, assignments, document opens.
 * Reading a lead or scrolling the board writes nothing, so "inactive" means
 * "did nothing the log records", not "wasn't at the screen".
 */
import { prisma } from "./prisma";

export const BUCKET_MINUTES = 10;
export const BUCKETS_PER_DAY = (24 * 60) / BUCKET_MINUTES;
const BUCKET_MS = BUCKET_MINUTES * 60_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

export interface UserActivityRow {
  sub: string;
  name: string;
  role: string | null;
  /** Actions per 10-minute slot, BUCKETS_PER_DAY long, from 00:00 IST. */
  counts: number[];
  total: number;
  /** Slots with at least one action — ×10 for active minutes. */
  activeBuckets: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface ActivityMonitorDTO {
  day: string;
  bucketMinutes: number;
  /** 00:00 IST of `day`, as an instant. */
  dayStart: string;
  /** Slot the current time falls in when `day` is today; slots after it
   *  haven't happened yet and aren't "inactive". Null for a past day, and
   *  -1 for a future one. */
  nowBucket: number | null;
  users: UserActivityRow[];
}

export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function istToday(now = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function istDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS);
}

export function nowBucketFor(day: string, now = new Date()): number | null {
  const start = istDayStart(day).getTime();
  const t = now.getTime();
  if (t < start) return -1;
  if (t >= start + BUCKETS_PER_DAY * BUCKET_MS) return null;
  return Math.floor((t - start) / BUCKET_MS);
}

/**
 * Folds per-slot counts into one row per person, adding staff who did nothing
 * at all that day (they are the point of an inactivity view). Busiest first,
 * then by name.
 */
export function buildRows(
  buckets: { sub: string; bucket: number; n: number }[],
  people: { sub: string; name: string | null; role: string | null; firstAt: Date | null; lastAt: Date | null }[],
  staff: { sub: string; name: string; role: string | null }[],
): UserActivityRow[] {
  const rows = new Map<string, UserActivityRow>();
  const ensure = (sub: string, name: string, role: string | null) => {
    let row = rows.get(sub);
    if (!row) {
      row = { sub, name, role, counts: new Array(BUCKETS_PER_DAY).fill(0), total: 0, activeBuckets: 0, firstAt: null, lastAt: null };
      rows.set(sub, row);
    }
    return row;
  };

  const staffBySub = new Map(staff.map((s) => [s.sub, s]));
  for (const p of people) {
    // Keycloak's current name and role beat whatever the log row cached.
    const s = staffBySub.get(p.sub);
    const row = ensure(p.sub, s?.name ?? p.name ?? "Unknown user", s?.role ?? p.role);
    row.firstAt = p.firstAt?.toISOString() ?? null;
    row.lastAt = p.lastAt?.toISOString() ?? null;
  }
  for (const b of buckets) {
    if (b.bucket < 0 || b.bucket >= BUCKETS_PER_DAY) continue;
    const row = rows.get(b.sub) ?? ensure(b.sub, staffBySub.get(b.sub)?.name ?? "Unknown user", staffBySub.get(b.sub)?.role ?? null);
    row.counts[b.bucket] += b.n;
    row.total += b.n;
  }
  for (const s of staff) ensure(s.sub, s.name, s.role);
  for (const row of rows.values()) row.activeBuckets = row.counts.filter((c) => c > 0).length;

  return [...rows.values()].sort((a, b) => b.activeBuckets - a.activeBuckets || b.total - a.total || a.name.localeCompare(b.name));
}

export async function getActivityMonitor(
  day: string,
  staff: { sub: string; name: string; role: string | null }[],
  now = new Date(),
): Promise<ActivityMonitorDTO> {
  const from = istDayStart(day);
  const to = new Date(from.getTime() + BUCKETS_PER_DAY * BUCKET_MS);

  // People only: automated actors (auto-reply, inbound mail, the WhatsApp
  // webhook, schedulers) all log as actorRole "system".
  const [buckets, people] = await Promise.all([
    prisma.$queryRaw<{ sub: string; bucket: number; n: number }[]>`
      SELECT "actorSub" AS sub,
             floor(extract(epoch FROM ("createdAt" - ${from}::timestamp)) / ${BUCKET_MS / 1000})::int AS bucket,
             count(*)::int AS n
      FROM "Activity"
      WHERE "createdAt" >= ${from}::timestamp AND "createdAt" < ${to}::timestamp AND "actorRole" <> 'system'
      GROUP BY 1, 2`,
    prisma.$queryRaw<{ sub: string; name: string | null; role: string | null; firstAt: Date | null; lastAt: Date | null }[]>`
      SELECT "actorSub" AS sub, max("actorName") AS name, max("actorRole") AS role,
             min("createdAt") AS "firstAt", max("createdAt") AS "lastAt"
      FROM "Activity"
      WHERE "createdAt" >= ${from}::timestamp AND "createdAt" < ${to}::timestamp AND "actorRole" <> 'system'
      GROUP BY 1`,
  ]);

  return {
    day,
    bucketMinutes: BUCKET_MINUTES,
    dayStart: from.toISOString(),
    nowBucket: nowBucketFor(day, now),
    users: buildRows(buckets, people, staff),
  };
}

/**
 * Each person's most recent action in the activity log (automated actors
 * excluded) — the "Last active" column on the Users page. Served by the
 * (actorSub, createdAt) index, so it stays cheap as the log grows.
 */
export async function lastActiveBySub(subs: string[]): Promise<Map<string, string>> {
  if (!subs.length) return new Map();
  const rows = await prisma.activity.groupBy({
    by: ["actorSub"],
    where: { actorSub: { in: subs }, actorRole: { not: "system" } },
    _max: { createdAt: true },
  });
  return new Map(
    rows.filter((r) => r._max.createdAt).map((r) => [r.actorSub, r._max.createdAt!.toISOString()]),
  );
}
