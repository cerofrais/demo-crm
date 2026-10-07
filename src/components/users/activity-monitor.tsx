"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button, Card, Input, Select } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { ActivityMonitorDTO, UserActivityRow } from "@/lib/user-activity";

// One mark hue for both charts — validated (dataviz validate_palette.js) for
// lightness, chroma and ≥3:1 contrast on the light and dark card surfaces.
// The brand teal #246a80 reads too close to gray for "active" to stand out.
const MARK = "#0a7ea4";

const SLOTS = 144;
const HOURS = {
  full: { from: 0, to: SLOTS, label: "Full day" },
  work: { from: 8 * 6, to: 22 * 6, label: "8 AM – 10 PM" },
} as const;
type HoursKey = keyof typeof HOURS;

function istToday(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}
function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
function slotTime(slot: number): string {
  const mins = slot * 10;
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function hourLabel(slot: number): string {
  const h = Math.floor(slot / 6) % 24;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? "AM" : "PM"}`;
}
function duration(slots: number): string {
  const mins = slots * 10;
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
}
function clock(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
const ROLE_LABEL = (role: string | null) => (role ? role.charAt(0) + role.slice(1).toLowerCase() : "");

/** Tracks an element's content width so SVGs draw at real pixel size. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Hour-label spacing in slots: every 2h, or 4h/6h when slots are too narrow to fit labels. */
function hourStep(slotW: number): number {
  return [12, 24, 36].find((step) => step * slotW >= 44) ?? 72;
}

/** Rounded, readable y-axis maximum and ticks. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? pow * 10;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

interface Tip {
  x: number;
  y: number;
  title: string;
  value: string;
  lines?: string[];
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-[9rem] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
      style={{ left: tip.x, top: tip.y, transform: "translate(-50%, calc(-100% - 8px))" }}
      role="status"
    >
      <div className="font-semibold text-foreground">{tip.value}</div>
      <div className="text-muted-foreground">{tip.title}</div>
      {tip.lines?.map((l) => (
        <div key={l} className="text-muted-foreground">{l}</div>
      ))}
    </div>
  );
}

export function ActivityMonitor() {
  const [day, setDay] = useState(istToday);
  // People picked for a closer look; empty means everyone.
  const [picked, setPicked] = useState<string[]>([]);
  const [hours, setHours] = useState<HoursKey>("work");
  const [hideIdle, setHideIdle] = useState(false);
  const [data, setData] = useState<ActivityMonitorDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<ActivityMonitorDTO>(`/api/users/activity-monitor?day=${d}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load activity");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(day);
  }, [day, load]);

  // Today refreshes itself every minute so "active now" stays true.
  useEffect(() => {
    if (day !== istToday()) return;
    const t = setInterval(() => load(day), 60_000);
    return () => clearInterval(t);
  }, [day, load]);

  const toggle = useCallback(
    (sub: string) => setPicked((p) => (p.includes(sub) ? p.filter((x) => x !== sub) : [...p, sub])),
    [],
  );

  const range = HOURS[hours];
  // Slots after "now" haven't happened — they're drawn as nothing, not inactive.
  const lastSlot = data?.nowBucket == null ? SLOTS - 1 : data.nowBucket;
  const everyone = useMemo(() => data?.users ?? [], [data]);
  // The selection, in the list's own order (busiest first), so picking order
  // doesn't shuffle the charts.
  const chosen = useMemo(
    () => (picked.length ? everyone.filter((u) => picked.includes(u.sub)) : []),
    [everyone, picked],
  );
  const scope = chosen.length ? chosen : everyone;
  const rows = scope.filter((u) => !hideIdle || u.activeBuckets > 0);

  const combined = useMemo(() => {
    const counts = new Array(SLOTS).fill(0);
    for (const u of everyone) u.counts.forEach((c, i) => (counts[i] += c));
    return counts as number[];
  }, [everyone]);
  const sharedMax = Math.max(1, ...chosen.flatMap((u) => u.counts.slice(range.from, range.to)));

  const isToday = day === istToday();
  const nb = data?.nowBucket;
  const activeNow = isToday && nb != null && nb >= 0
    ? scope.filter((u) => u.counts[nb] > 0 || (nb > 0 && u.counts[nb - 1] > 0))
    : [];
  const activeStaff = scope.filter((u) => u.activeBuckets > 0).length;
  const actions = scope.reduce((a, u) => a + u.total, 0);
  const scopeLabel = chosen.length === 0 ? "All staff" : chosen.length === 1 ? chosen[0].name : `${chosen.length} people`;

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* Filters — one row, scoping everything below. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => setDay((d) => shiftDay(d, -1))} aria-label="Previous day">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Input type="date" value={day} max={istToday()} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9 w-40" aria-label="Day" />
          <Button
            size="icon"
            variant="outline"
            className="h-9 w-9"
            onClick={() => setDay((d) => shiftDay(d, 1))}
            disabled={day >= istToday()}
            aria-label="Next day"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {!isToday && (
            <Button size="sm" variant="ghost" onClick={() => setDay(istToday())}>Today</Button>
          )}
        </div>
        <PeoplePicker users={everyone} picked={picked} onToggle={toggle} onClear={() => setPicked([])} onPickActive={() => setPicked(everyone.filter((u) => u.activeBuckets > 0).map((u) => u.sub))} />
        <Select value={hours} onChange={(e) => setHours(e.target.value as HoursKey)} className="h-9 w-40" aria-label="Hours">
          {(Object.keys(HOURS) as HoursKey[]).map((k) => (
            <option key={k} value={k}>{HOURS[k].label}</option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} className="h-4 w-4 accent-brand-600" />
          Hide staff with no activity
        </label>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {error && <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</Card>}

      <div className={cn("space-y-4 transition-opacity", loading && data && "opacity-60")}>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Active now"
            value={isToday ? String(activeNow.length) : "—"}
            note={isToday ? (activeNow.length ? activeNow.map((u) => u.name).join(", ") : "Nobody in the last 10–20 minutes") : "Only for today"}
          />
          <StatTile label="Staff active" value={`${activeStaff} of ${scope.length}`} note={`${scopeLabel} · at least one action this day`} />
          <StatTile label="Actions logged" value={actions.toLocaleString("en-IN")} note={`${scopeLabel} · remarks, stage moves, messages, calls, tasks…`} />
        </div>

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-foreground">Actions per 10 minutes</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            {chosen.length === 0
              ? `All staff combined · ${range.label}`
              : chosen.length === 1
                ? `${chosen[0].name} · ${range.label}`
                : `One chart per person, on the same scale · ${range.label}`}
          </p>
          {!data ? (
            <div className="h-48" />
          ) : chosen.length === 0 ? (
            <CountChart counts={combined} from={range.from} to={range.to} lastSlot={lastSlot} users={everyone} />
          ) : (
            <div className="space-y-4">
              {chosen.map((u) => (
                <div key={u.sub}>
                  {chosen.length > 1 && (() => {
                    // Counted within the hours shown, to match the chart and timeline.
                    const shown = u.counts.slice(range.from, range.to);
                    const acts = shown.reduce((a, c) => a + c, 0);
                    const slots = shown.filter((c) => c > 0).length;
                    return (
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                        <span className="font-medium text-foreground">{u.name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {acts} action{acts === 1 ? "" : "s"} · {slots ? duration(slots) : "no"} active
                        </span>
                      </div>
                    );
                  })()}
                  <CountChart
                    counts={u.counts}
                    from={range.from}
                    to={range.to}
                    lastSlot={lastSlot}
                    users={null}
                    yMax={chosen.length > 1 ? sharedMax : undefined}
                    height={chosen.length > 1 ? 130 : 200}
                    label={`Actions per 10-minute slot for ${u.name}`}
                  />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Active or inactive</h2>
              <p className="text-xs text-muted-foreground">
                Active when someone did anything the activity log records in those 10 minutes; inactive when they did nothing.
                {" "}Click a row to add or remove that person.
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: MARK }} /> Active</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-slate-200 dark:bg-slate-700" /> Inactive</span>
            </div>
          </div>
          {data && rows.length > 0 ? (
            <ActiveTimeline users={rows} from={range.from} to={range.to} lastSlot={lastSlot} onToggle={toggle} />
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">{data ? "No staff to show." : ""}</p>
          )}
        </Card>

        {data && (
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-2">
              <h2 className="text-sm font-semibold text-foreground">Summary</h2>
              <span className="text-xs text-muted-foreground">Tick people to compare them in the charts above.</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-y border-border bg-muted/40 text-left text-xs">
                  <tr>
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select everyone"
                        checked={picked.length > 0 && picked.length === everyone.length}
                        ref={(el) => { if (el) el.indeterminate = picked.length > 0 && picked.length < everyone.length; }}
                        onChange={() => setPicked(picked.length === everyone.length ? [] : everyone.map((u) => u.sub))}
                        className="h-4 w-4 accent-brand-600"
                      />
                    </th>
                    {["Person", "Role", "Active time", "Actions", "First action", "Last action"].map((h) => (
                      <th key={h} className="px-3 py-2 font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {everyone.filter((u) => !hideIdle || u.activeBuckets > 0).map((u) => {
                    const on = picked.includes(u.sub);
                    return (
                      <tr
                        key={u.sub}
                        onClick={() => toggle(u.sub)}
                        className={cn("cursor-pointer hover:bg-muted/30", on && "bg-brand-50 dark:bg-brand-900/30")}
                      >
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(u.sub)}
                            aria-label={`Select ${u.name}`}
                            className="h-4 w-4 accent-brand-600"
                          />
                        </td>
                        <td className="px-3 py-2 font-medium">{u.name}</td>
                        <td className="px-3 py-2 text-muted-foreground">{ROLE_LABEL(u.role)}</td>
                        <td className="px-3 py-2 tabular-nums">{u.activeBuckets ? duration(u.activeBuckets) : "—"}</td>
                        <td className="px-3 py-2 tabular-nums">{u.total}</td>
                        <td className="px-3 py-2 tabular-nums">{clock(u.firstAt)}</td>
                        <td className="px-3 py-2 tabular-nums">{clock(u.lastAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-2 text-[11px] text-muted-foreground">
              Active time is counted in 10-minute slots. Reading leads or scrolling the board writes nothing to the activity log, so it doesn&apos;t count.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

/** Multi-select for people: a button that opens a checkbox list. */
function PeoplePicker({
  users, picked, onToggle, onClear, onPickActive,
}: {
  users: UserActivityRow[];
  picked: string[];
  onToggle: (sub: string) => void;
  onClear: () => void;
  onPickActive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const names = users.filter((u) => picked.includes(u.sub)).map((u) => u.name);
  const label = !picked.length ? "All staff" : names.length === 1 ? names[0] : `${picked.length} people`;

  return (
    <div ref={box} className="relative">
      <Button
        variant="outline"
        className="h-9 w-48 justify-between font-normal"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-64 rounded-md border border-border bg-popover p-1 shadow-lg" role="listbox" aria-multiselectable>
          <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-xs">
            <button type="button" onClick={onClear} className="text-brand-700 hover:underline">All staff</button>
            <button type="button" onClick={onPickActive} className="text-brand-700 hover:underline">Only people active this day</button>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {users.map((u) => (
              <label key={u.sub} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                <input type="checkbox" checked={picked.includes(u.sub)} onChange={() => onToggle(u.sub)} className="h-4 w-4 accent-brand-600" />
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{u.activeBuckets ? duration(u.activeBuckets) : "—"}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground" title={note}>{note}</div>
    </Card>
  );
}

const AXIS_W = 36;
const X_AXIS_H = 20;

function CountChart({
  counts, from, to, lastSlot, users, yMax, height = 200, label = "Actions per 10-minute slot",
}: {
  counts: number[];
  from: number;
  to: number;
  lastSlot: number;
  /** All staff, to list who was busy in a slot — null when one person is plotted. */
  users: UserActivityRow[] | null;
  /** Shared scale for small multiples, so people compare bar for bar. */
  yMax?: number;
  height?: number;
  label?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const plotW = Math.max(0, width - AXIS_W);
  const plotH = height - X_AXIS_H - 8;
  const n = to - from;
  const slotW = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(24, slotW - 2));
  const ticks = niceTicks(yMax ?? Math.max(...counts.slice(from, to)));
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => 8 + plotH - (v / top) * plotH;

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={AXIS_W} x2={width} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
              <text x={AXIS_W - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                {t}
              </text>
            </g>
          ))}
          {Array.from({ length: n }, (_, i) => from + i)
            .filter((s) => s % hourStep(slotW) === 0)
            .map((s) => (
              <text key={s} x={AXIS_W + (s - from) * slotW} y={height - 4} textAnchor="start" className="fill-muted-foreground text-[10px]">
                {hourLabel(s)}
              </text>
            ))}
          {Array.from({ length: n }, (_, i) => from + i).map((s) => {
            if (s > lastSlot) return null;
            const v = counts[s];
            const x = AXIS_W + (s - from) * slotW + (slotW - barW) / 2;
            const h = plotH - (y(v) - 8);
            const r = Math.min(4, barW / 2, h);
            return (
              <g key={s}>
                {v > 0 && (
                  <path
                    d={`M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
                    fill={MARK}
                  />
                )}
                <rect
                  x={AXIS_W + (s - from) * slotW}
                  y={8}
                  width={slotW}
                  height={plotH}
                  fill="transparent"
                  onPointerMove={() => {
                    const busy = users
                      ? users.filter((u) => u.counts[s] > 0).sort((a, b) => b.counts[s] - a.counts[s]).map((u) => `${u.name}: ${u.counts[s]}`)
                      : undefined;
                    setTip({
                      x: AXIS_W + (s - from + 0.5) * slotW,
                      y: y(v),
                      value: `${v} action${v === 1 ? "" : "s"}`,
                      title: `${slotTime(s)} – ${slotTime(s + 1)}`,
                      lines: busy?.slice(0, 6),
                    });
                  }}
                />
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

const ROW_H = 26;

function ActiveTimeline({
  users, from, to, lastSlot, onToggle,
}: {
  users: UserActivityRow[];
  from: number;
  to: number;
  lastSlot: number;
  /** Clicking a row adds that person to (or removes them from) the selection. */
  onToggle: (sub: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  // Narrow screens give the track more of the width.
  const compact = width < 520;
  const LABEL_W = compact ? 100 : 150;
  const TOTAL_W = compact ? 46 : 64;
  const nameMax = compact ? 13 : 20;
  const trackW = Math.max(0, width - LABEL_W - TOTAL_W);
  const n = to - from;
  const slotW = n ? trackW / n : 0;
  const end = Math.min(to, lastSlot + 1);
  const height = users.length * ROW_H + X_AXIS_H;

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Active or inactive per 10-minute slot, per person">
          {Array.from({ length: n + 1 }, (_, i) => from + i)
            .filter((s) => s % hourStep(slotW) === 0 && s < to)
            .map((s) => (
              <g key={s}>
                <line x1={LABEL_W + (s - from) * slotW} x2={LABEL_W + (s - from) * slotW} y1={0} y2={users.length * ROW_H} className="stroke-border" strokeWidth={1} />
                <text x={LABEL_W + (s - from) * slotW} y={height - 4} className="fill-muted-foreground text-[10px]">{hourLabel(s)}</text>
              </g>
            ))}
          {users.map((u, row) => {
            const top = row * ROW_H + 5;
            const barH = ROW_H - 10;
            // Merge consecutive active slots into runs — one rounded bar each.
            const runs: [number, number][] = [];
            for (let s = from; s < end; s++) {
              if (u.counts[s] > 0) {
                const last = runs[runs.length - 1];
                if (last && last[1] === s) last[1] = s + 1;
                else runs.push([s, s + 1]);
              }
            }
            return (
              <g key={u.sub} className="cursor-pointer" onClick={() => { setTip(null); onToggle(u.sub); }}>
                <text x={0} y={top + barH / 2} dy="0.32em" className="fill-foreground text-[12px]">
                  {u.name.length > nameMax ? `${u.name.slice(0, nameMax - 1)}…` : u.name}
                </text>
                {end > from && (
                  <rect x={LABEL_W} y={top} width={(end - from) * slotW} height={barH} rx={3} className="fill-slate-200 dark:fill-slate-700" />
                )}
                {runs.map(([a, b]) => (
                  <rect key={a} x={LABEL_W + (a - from) * slotW} y={top} width={Math.max(2, (b - a) * slotW)} height={barH} rx={Math.min(3, ((b - a) * slotW) / 2)} fill={MARK} />
                ))}
                <text x={width - 4} y={top + barH / 2} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                  {u.activeBuckets ? duration(u.counts.slice(from, end).filter((c) => c > 0).length) : "—"}
                </text>
                <rect
                  x={LABEL_W}
                  y={row * ROW_H}
                  width={trackW}
                  height={ROW_H}
                  fill="transparent"
                  onPointerMove={(e) => {
                    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    const s = from + Math.floor((e.clientX - box.left - LABEL_W) / slotW);
                    if (s < from || s >= to) return;
                    const future = s > lastSlot;
                    const c = u.counts[s] ?? 0;
                    setTip({
                      x: LABEL_W + (s - from + 0.5) * slotW,
                      y: top,
                      value: future ? "Not yet" : c > 0 ? `Active · ${c} action${c === 1 ? "" : "s"}` : "Inactive",
                      title: `${u.name} · ${slotTime(s)} – ${slotTime(s + 1)}`,
                    });
                  }}
                />
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}
