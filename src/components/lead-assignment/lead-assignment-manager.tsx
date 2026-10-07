"use client";

import { useCallback, useEffect, useState } from "react";
import { Shuffle, Loader2, Plus, X, MessageCircle, Mail, Phone, FileSpreadsheet, Globe, Instagram, Facebook, ClipboardCheck, Users as UsersIcon, Megaphone, Smartphone, CalendarOff, Trash2, Tag as TagIcon } from "lucide-react";
import { Card, Badge, Button, Select, Input, ScrollableTabs } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { slugifyTag } from "@/lib/lead-tags";

type Category =
  | "whatsapp"
  | "email"
  | "call"
  | "google_sheets"
  | "website_form"
  | "instagram"
  | "facebook"
  | "medical_form";
type Strategy = "round_robin" | "least_busy";

interface SettingsDTO {
  category: Category;
  strategy: Strategy;
  eligibleSubs: string[];
  /** Pre-arrival forms only — see CATEGORY_META.medical_form. */
  reassignExisting?: boolean;
}

interface TagRuleDTO {
  tag: string;
  label: string;
  strategy: Strategy;
  eligibleSubs: string[];
  priority: number;
}

interface CampaignRuleDTO {
  campaignSlug: string;
  campaignLabel: string;
  strategy: Strategy;
  eligibleSubs: string[];
}

interface WhatsAppNumberRuleDTO {
  ourNumber: string;
  label: string;
  strategy: Strategy;
  eligibleSubs: string[];
}

interface KnownNumberDTO {
  ourNumber: string;
  label: string;
  integration: string;
  status: string;
}

interface AvailabilityLeave {
  id: string;
  startDate: string;
  endDate: string;
  note: string | null;
}

interface AvailabilityShift {
  weekday: number;
  start: string;
  end: string;
}

interface AvailabilityRow {
  sub: string;
  name: string;
  role: string | null;
  isOnline: boolean;
  weeklyOffDays: number[];
  shifts: AvailabilityShift[];
  onShiftNow: boolean;
  offToday: boolean;
  onLeaveToday: boolean;
  leave: AvailabilityLeave[];
}

interface StaffProfile {
  keycloakId: string;
  displayName: string;
  role: string | null;
  isOnline: boolean;
}

const CATEGORY_META: Record<Category, { label: string; icon: typeof MessageCircle; blurb: string }> = {
  whatsapp: {
    label: "Incoming WhatsApp",
    icon: MessageCircle,
    blurb: "A new lead created from an unrecognized WhatsApp number.",
  },
  email: {
    label: "Incoming Email",
    icon: Mail,
    blurb: "A new lead created from an unrecognized sender emailing the sales inbox.",
  },
  call: {
    label: "Incoming Calls",
    icon: Phone,
    blurb: "Who gets rung for a call from an unrecognized number — whoever answered becomes that lead's owner.",
  },
  google_sheets: {
    label: "Google Sheets",
    icon: FileSpreadsheet,
    blurb: "A lead ingested from the n8n Google Sheets workflow (source=google_sheets).",
  },
  website_form: {
    label: "Website Form",
    icon: Globe,
    blurb: "A lead from an enquiry form on the website (source=website_form).",
  },
  instagram: {
    label: "Instagram",
    icon: Instagram,
    blurb: "A lead attributed to Instagram — an ad or a DM-sourced enquiry.",
  },
  facebook: {
    label: "Facebook",
    icon: Facebook,
    blurb: "A lead attributed to Facebook — an ad or a Page enquiry.",
  },
  medical_form: {
    label: "Pre-arrival forms",
    icon: ClipboardCheck,
    blurb:
      "A guest's pre-arrival medical screening form. It arrives by email, so without this rule it follows Incoming Email — set it here to send pre-arrival forms to Front Office without re-routing every other email enquiry.",
  },
};

const STRATEGY_LABEL: Record<Strategy, string> = {
  round_robin: "Round robin",
  least_busy: "Least busy",
};

const STRATEGY_DESCRIPTION: Record<Strategy, string> = {
  round_robin: "Cycles through the selected staff in turn, one lead each.",
  least_busy: "Always goes to whoever currently has the fewest open leads.",
};

export function LeadAssignmentManager({ canManage }: { canManage: boolean }) {
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [settings, setSettings] = useState<Record<Category, SettingsDTO> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Category | null>(null);
  const [saved, setSaved] = useState<Category | null>(null);
  // Routing rules and the rota answer different questions — "where does a new
  // lead go" versus "who is working today" — and stacking them made a long
  // page where the rota sat below four other cards.
  const [tab, setTab] = useState<"routing" | "daysOff">("routing");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [staffRes, settingsRes] = await Promise.all([
        api.get<StaffProfile[]>("/api/staff-profiles"),
        api.get<SettingsDTO[]>("/api/admin/lead-assignment"),
      ]);
      setStaff(staffRes);
      setSettings(Object.fromEntries(settingsRes.map((s) => [s.category, s])) as Record<Category, SettingsDTO>);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load lead-assignment settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function updateLocal(category: Category, patch: Partial<SettingsDTO>) {
    if (!canManage) return;
    setSettings((prev) => (prev ? { ...prev, [category]: { ...prev[category], ...patch } } : prev));
  }

  function addStaff(category: Category, keycloakId: string) {
    if (!settings || settings[category].eligibleSubs.includes(keycloakId)) return;
    updateLocal(category, { eligibleSubs: [...settings[category].eligibleSubs, keycloakId] });
  }

  function removeStaff(category: Category, keycloakId: string) {
    if (!settings) return;
    updateLocal(category, { eligibleSubs: settings[category].eligibleSubs.filter((id) => id !== keycloakId) });
  }

  async function save(category: Category) {
    if (!settings || busy || !canManage) return;
    setBusy(category);
    setSaved(null);
    try {
      const updated = await api.patch<SettingsDTO>("/api/admin/lead-assignment", {
        category,
        strategy: settings[category].strategy,
        eligibleSubs: settings[category].eligibleSubs,
        reassignExisting: settings[category].reassignExisting ?? false,
      });
      updateLocal(category, updated);
      setSaved(category);
      setTimeout(() => setSaved((s) => (s === category ? null : s)), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      {loading && !settings ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Shuffle className="mr-2 h-5 w-5 animate-pulse" /> Loading…
        </div>
      ) : error ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          <p>{error}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={load}>Retry</Button>
        </Card>
      ) : settings ? (
        <>
          <ScrollableTabs
            tabs={[
              { key: "routing", label: "Assignment rules" },
              { key: "daysOff", label: "Days off" },
            ]}
            active={tab}
            onChange={(k) => setTab(k as "routing" | "daysOff")}
          />

          {tab === "daysOff" ? (
            <AvailabilitySection canManage={canManage} />
          ) : (
          <>
          {(Object.keys(CATEGORY_META) as Category[]).map((category) => (
            <CategorySection
              key={category}
              category={category}
              settings={settings[category]}
              staff={staff}
              canManage={canManage}
              busy={busy === category}
              saved={saved === category}
              onStrategyChange={(strategy) => updateLocal(category, { strategy })}
              onReassignChange={(reassignExisting) => updateLocal(category, { reassignExisting })}
              onAddStaff={(id) => addStaff(category, id)}
              onRemoveStaff={(id) => removeStaff(category, id)}
              onSave={() => save(category)}
            />
          ))}
          <WhatsAppNumbersSection staff={staff} canManage={canManage} />
          <CampaignsSection staff={staff} canManage={canManage} />
          <TagsSection staff={staff} canManage={canManage} />
          </>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Chip list + search-to-add control for picking eligible staff — identical
 *  behavior whether it's backing a fixed channel category or a campaign
 *  rule, so both sections share this instead of duplicating the JSX. */
function EligibleStaffPicker({
  idPrefix,
  staff,
  eligibleSubs,
  canManage,
  onAdd,
  onRemove,
}: {
  idPrefix: string;
  staff: StaffProfile[];
  eligibleSubs: string[];
  canManage: boolean;
  onAdd: (keycloakId: string) => void;
  onRemove: (keycloakId: string) => void;
}) {
  const byId = new Map(staff.map((s) => [s.keycloakId, s]));
  const added = eligibleSubs.map((id) => byId.get(id)).filter((s): s is StaffProfile => Boolean(s));
  const available = staff.filter((s) => !eligibleSubs.includes(s.keycloakId));

  const [input, setInput] = useState("");
  const datalistId = `${idPrefix}-staff`;

  function addByName(name: string) {
    const q = name.trim().toLowerCase();
    if (!q) return;
    const match = available.find((s) => s.displayName.toLowerCase() === q);
    if (!match) return;
    onAdd(match.keycloakId);
    setInput("");
  }

  return (
    <div className="mt-4 space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <UsersIcon className="h-3.5 w-3.5" />
        Eligible staff — leave empty to use the default pool instead of a fixed list.
      </p>

      <div className="flex flex-wrap gap-1.5">
        {added.map((s) => (
          <span
            key={s.keycloakId}
            className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700"
          >
            {s.displayName}
            {canManage && (
              <button
                onClick={() => onRemove(s.keycloakId)}
                className="-my-1 -mr-1 flex items-center justify-center p-1.5 hover:opacity-60"
                title="Remove"
                aria-label={`Remove ${s.displayName}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {added.length === 0 && <span className="text-xs text-muted-foreground">Nobody added yet.</span>}
      </div>

      {canManage && (
        <div className="flex gap-2">
          <Input
            list={datalistId}
            value={input}
            placeholder="Search staff by name…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addByName(input);
              }
            }}
          />
          <datalist id={datalistId}>
            {available.map((s) => (
              <option key={s.keycloakId} value={s.displayName} />
            ))}
          </datalist>
          <Button variant="outline" onClick={() => addByName(input)} disabled={!input.trim()}>
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

function CategorySection({
  category,
  settings,
  staff,
  canManage,
  busy,
  saved,
  onStrategyChange,
  onReassignChange,
  onAddStaff,
  onRemoveStaff,
  onSave,
}: {
  category: Category;
  settings: SettingsDTO;
  staff: StaffProfile[];
  canManage: boolean;
  busy: boolean;
  saved: boolean;
  onStrategyChange: (s: Strategy) => void;
  onReassignChange: (reassignExisting: boolean) => void;
  onAddStaff: (keycloakId: string) => void;
  onRemoveStaff: (keycloakId: string) => void;
  onSave: () => void;
}) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  const restricted = settings.eligibleSubs.length > 0;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{meta.label}</h3>
              <Badge className={cn("text-xs", restricted ? "bg-amber-100 text-amber-800" : "bg-secondary text-secondary-foreground")}>
                {restricted ? `Restricted to ${settings.eligibleSubs.length}` : "Default pool"}
              </Badge>
            </div>
            <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">{meta.blurb}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Select
            value={settings.strategy}
            onChange={(e) => onStrategyChange(e.target.value as Strategy)}
            disabled={!canManage}
            className="h-8 w-36 text-xs"
          >
            {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => (
              <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
            ))}
          </Select>
        </div>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{STRATEGY_DESCRIPTION[settings.strategy]}</p>

      <EligibleStaffPicker
        idPrefix={`lead-assignment-${category}`}
        staff={staff}
        eligibleSubs={settings.eligibleSubs}
        canManage={canManage}
        onAdd={onAddStaff}
        onRemove={onRemoveStaff}
      />

      {/* Only pre-arrival forms ask this: a form arrives for a guest who is
          nearly here, and the job becomes Front Office's — but taking a card
          off the rep who has been talking to them is a decision, not a
          default. Unticked, the rule routes only leads the form creates. */}
      {category === "medical_form" && (
        <label className="mt-3 flex max-w-xl cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={settings.reassignExisting ?? false}
            onChange={(e) => onReassignChange(e.target.checked)}
            disabled={!canManage || settings.eligibleSubs.length === 0}
            className="mt-0.5 h-3.5 w-3.5 rounded border-input accent-brand-600"
          />
          <span>
            Also hand over a lead that already has an owner. Without this, a form only decides the owner of leads it
            creates, and a lead someone is already working stays with them.
          </span>
        </label>
      )}

      {canManage && (
        <div className="mt-4 flex items-center gap-2">
          <Button size="sm" onClick={onSave} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
          {saved && <span className="text-xs text-emerald-600">Saved</span>}
        </div>
      )}
    </Card>
  );
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Days off — a weekly rota plus dated leave.
 *
 * Somebody off today is skipped by every assignment path AND by inbound call
 * routing, and if a channel's whole pool is off the lead is left unassigned
 * rather than parked in a queue nobody is reading.
 *
 * Read in IST, so "Monday off" is the Monday the person actually has off.
 */
function AvailabilitySection({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<AvailabilityRow[] | null>(null);
  const [today, setToday] = useState<{ date: string; weekday: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busySub, setBusySub] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hoursFor, setHoursFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ today: { date: string; weekday: number }; staff: AvailabilityRow[] }>(
        "/api/admin/staff-availability",
      );
      setRows(res.staff);
      setToday(res.today);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load days off");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleDay(row: AvailabilityRow, day: number) {
    if (!canManage || busySub) return;
    const next = row.weeklyOffDays.includes(day)
      ? row.weeklyOffDays.filter((d) => d !== day)
      : [...row.weeklyOffDays, day];
    setBusySub(row.sub);
    // Optimistic: the grid is a lot of small clicks and waiting on each one
    // makes setting a rota feel broken.
    setRows((prev) => prev?.map((r) => (r.sub === row.sub ? { ...r, weeklyOffDays: next } : r)) ?? prev);
    try {
      await api.put("/api/admin/staff-availability", { sub: row.sub, weeklyOffDays: next });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      await load();
    } finally {
      setBusySub(null);
    }
  }

  async function setShift(sub: string, weekday: number, start: string | null, end: string | null) {
    setBusySub(sub);
    try {
      await api.patch("/api/admin/staff-availability", { sub, weekday, start, end });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save hours");
    } finally {
      setBusySub(null);
    }
  }

  async function addLeave(sub: string) {
    if (!from || !to) return;
    setBusySub(sub);
    try {
      await api.post("/api/admin/staff-availability", { sub, startDate: from, endDate: to });
      setAddingFor(null);
      setFrom("");
      setTo("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add leave");
    } finally {
      setBusySub(null);
    }
  }

  async function removeLeave(id: string, sub: string) {
    setBusySub(sub);
    try {
      await api.delete(`/api/admin/staff-availability?leaveId=${encodeURIComponent(id)}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove leave");
    } finally {
      setBusySub(null);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <CalendarOff className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Days off</h3>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
            A weekly rota plus one-off leave. Anyone off today is skipped by lead assignment and by
            inbound calls. If everyone on a channel is off, the lead is left unassigned rather than
            given to someone who isn&apos;t working.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-4 space-y-3">
        {rows === null ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No lead-working staff found.</p>
        ) : (
          rows.map((row) => (
            <div key={row.sub} className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{row.name}</span>
                  <span className="text-xs text-muted-foreground">{row.role}</span>
                  {row.offToday ? (
                    <Badge className="bg-amber-100 text-xs text-amber-800">
                      {row.onLeaveToday ? "On leave today" : "Off today"}
                    </Badge>
                  ) : row.onShiftNow ? (
                    <Badge className="bg-emerald-100 text-xs text-emerald-800">On shift now</Badge>
                  ) : (
                    <Badge className="bg-secondary text-xs text-secondary-foreground">Off shift now</Badge>
                  )}
                </div>
                <div className="flex gap-1">
                  {DAY_LABELS.map((label, day) => {
                    const off = row.weeklyOffDays.includes(day);
                    return (
                      <button
                        key={day}
                        onClick={() => toggleDay(row, day)}
                        disabled={!canManage || busySub === row.sub}
                        title={off ? `${label} — off` : `${label} — working`}
                        aria-pressed={off}
                        className={cn(
                          "h-7 w-9 rounded-md border text-[11px] font-medium transition-colors",
                          off
                            ? "border-amber-300 bg-amber-100 text-amber-800"
                            : "border-border text-muted-foreground hover:bg-secondary",
                          today?.weekday === day && "ring-1 ring-brand-400",
                          !canManage && "cursor-default opacity-70",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {hoursFor === row.sub && (
                <div className="mt-3 space-y-1.5 rounded-md border border-border bg-secondary/30 p-2.5">
                  <p className="text-[11px] text-muted-foreground">
                    Hours are IST. A shift that ends before it starts runs overnight — 22:00 to
                    06:00 is a night shift. Leave a day blank and they work it in full.
                  </p>
                  {DAY_LABELS.map((label, day) => {
                    const shift = row.shifts.find((sh) => sh.weekday === day);
                    const isOff = row.weeklyOffDays.includes(day);
                    return (
                      <div key={day} className="flex items-center gap-2">
                        <span className="w-9 text-xs text-muted-foreground">{label}</span>
                        {isOff ? (
                          <span className="text-xs text-muted-foreground">Day off</span>
                        ) : (
                          <>
                            <Input
                              type="time"
                              defaultValue={shift?.start ?? ""}
                              onBlur={(e) => {
                                const end = row.shifts.find((sh) => sh.weekday === day)?.end ?? "";
                                if (e.target.value && end) setShift(row.sub, day, e.target.value, end);
                                if (!e.target.value && shift) setShift(row.sub, day, null, null);
                              }}
                              className="h-7 w-28 text-xs"
                            />
                            <span className="text-xs text-muted-foreground">to</span>
                            <Input
                              type="time"
                              defaultValue={shift?.end ?? ""}
                              onBlur={(e) => {
                                const start = row.shifts.find((sh) => sh.weekday === day)?.start ?? "";
                                if (start && e.target.value) setShift(row.sub, day, start, e.target.value);
                                if (!e.target.value && shift) setShift(row.sub, day, null, null);
                              }}
                              className="h-7 w-28 text-xs"
                            />
                            {shift ? (
                              <button
                                onClick={() => setShift(row.sub, day, null, null)}
                                className="text-[11px] text-muted-foreground hover:text-destructive"
                              >
                                clear
                              </button>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">all day</span>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {row.leave.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {row.leave.map((l) => (
                    <span
                      key={l.id}
                      className="flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground"
                    >
                      {l.startDate === l.endDate ? l.startDate : `${l.startDate} → ${l.endDate}`}
                      {canManage && (
                        <button
                          onClick={() => removeLeave(l.id, row.sub)}
                          aria-label="Remove this leave"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {canManage && (
                <div className="mt-3">
                  {addingFor === row.sub ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40 text-xs" />
                      <span className="text-xs text-muted-foreground">to</span>
                      <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40 text-xs" />
                      <Button size="sm" onClick={() => addLeave(row.sub)} disabled={!from || !to || busySub === row.sub}>
                        {busySub === row.sub && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Save leave
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAddingFor(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => { setAddingFor(row.sub); setFrom(""); setTo(""); }}
                      >
                        <Plus className="h-4 w-4" />
                        Add leave
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setHoursFor(hoursFor === row.sub ? null : row.sub)}
                      >
                        {hoursFor === row.sub ? "Hide hours" : "Shift hours"}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

/**
 * Per-number rules for inbound WhatsApp — "messages arriving on the doctor's
 * line go to the doctor's team".
 *
 * Checked BEFORE the campaign and channel rules (see resolveAutoAssignee in
 * lib/enquiry-service.ts): which line a guest wrote to is the most concrete
 * routing fact available when the lead is opened, whereas the `whatsapp`
 * channel rule only knows it arrived on WhatsApp at all.
 *
 * Unlike campaigns, the set of numbers is finite and known, so this offers a
 * picker rather than a free-text box — an admin cannot invent a rule for a
 * number we don't own and then wonder why it never fires. Keyed on the E.164
 * number, not the WhatsAppNumber row: a QR-paired line is re-created with a
 * new id every time it re-pairs, which would orphan an id-keyed rule.
 *
 * Only applies to leads OPENED by an inbound message. An existing guest
 * messaging in again attaches to their current lead and keeps its owner.
 */
function WhatsAppNumbersSection({ staff, canManage }: { staff: StaffProfile[]; canManage: boolean }) {
  const [rules, setRules] = useState<WhatsAppNumberRuleDTO[] | null>(null);
  const [knownNumbers, setKnownNumbers] = useState<KnownNumberDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState<WhatsAppNumberRuleDTO | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ rules: WhatsAppNumberRuleDTO[]; knownNumbers: KnownNumberDTO[] }>(
        "/api/admin/lead-assignment/whatsapp-numbers",
      );
      setRules(res.rules);
      setKnownNumbers(res.knownNumbers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load WhatsApp number rules");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(rule: WhatsAppNumberRuleDTO) {
    if (busyNumber || !canManage) return;
    setBusyNumber(rule.ourNumber);
    try {
      await api.put("/api/admin/lead-assignment/whatsapp-numbers", {
        ourNumber: rule.ourNumber,
        label: rule.label,
        strategy: rule.strategy,
        eligibleSubs: rule.eligibleSubs,
      });
      setDraft(null);
      setSaved(rule.ourNumber);
      setTimeout(() => setSaved((s) => (s === rule.ourNumber ? null : s)), 2000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save WhatsApp number rule");
    } finally {
      setBusyNumber(null);
    }
  }

  function startAdding() {
    const n = knownNumbers.find((k) => k.ourNumber === picked);
    if (!n) return;
    setDraft({ ourNumber: n.ourNumber, label: n.label, strategy: "round_robin", eligibleSubs: [] });
    setPicked("");
  }

  const configured = new Set((rules ?? []).map((r) => r.ourNumber));
  const addable = knownNumbers.filter((n) => !configured.has(n.ourNumber) && n.ourNumber !== draft?.ourNumber);

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <Smartphone className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">WhatsApp number-based assignment</h3>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
            Route new WhatsApp leads by which of your numbers they messaged. Takes priority over the
            campaign and channel rules. Only applies to leads opened by a first-time sender — someone
            already in the CRM keeps their existing owner.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-4 space-y-4">
        {rules === null ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {rules.map((rule) => (
              <WhatsAppNumberRuleCard
                key={rule.ourNumber}
                rule={rule}
                staff={staff}
                canManage={canManage}
                busy={busyNumber === rule.ourNumber}
                saved={saved === rule.ourNumber}
                onChange={(patch) => {
                  const next = { ...rule, ...patch };
                  setRules((prev) => prev?.map((r) => (r.ourNumber === rule.ourNumber ? next : r)) ?? prev);
                }}
                onSave={(next) => save(next)}
                onRemove={() => save({ ...rule, eligibleSubs: [] })}
              />
            ))}

            {draft && (
              <WhatsAppNumberRuleCard
                rule={draft}
                staff={staff}
                canManage={canManage}
                busy={busyNumber === draft.ourNumber}
                saved={false}
                isDraft
                onChange={(patch) => setDraft((d) => (d ? { ...d, ...patch } : d))}
                onSave={(next) => save(next)}
                onRemove={() => setDraft(null)}
              />
            )}

            {rules.length === 0 && !draft && (
              <p className="text-xs text-muted-foreground">
                No number rules configured — every WhatsApp lead follows the channel rule above.
              </p>
            )}
          </>
        )}

        {canManage && !draft && addable.length > 0 && (
          <div className="flex gap-2 border-t border-border pt-4">
            <Select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="h-9 max-w-xs text-xs"
            >
              <option value="">Choose a number…</option>
              {addable.map((n) => (
                <option key={n.ourNumber} value={n.ourNumber}>
                  {n.label} · {n.ourNumber}
                </option>
              ))}
            </Select>
            <Button variant="outline" onClick={startAdding} disabled={!picked}>
              <Plus className="h-4 w-4" />
              Add number rule
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function WhatsAppNumberRuleCard({
  rule,
  staff,
  canManage,
  busy,
  saved,
  isDraft,
  onChange,
  onSave,
  onRemove,
}: {
  rule: WhatsAppNumberRuleDTO;
  staff: StaffProfile[];
  canManage: boolean;
  busy: boolean;
  saved: boolean;
  isDraft?: boolean;
  onChange: (patch: Partial<WhatsAppNumberRuleDTO>) => void;
  onSave: (rule: WhatsAppNumberRuleDTO) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">{rule.label}</h4>
            <span className="font-mono text-xs text-muted-foreground">{rule.ourNumber}</span>
            {isDraft && <Badge className="bg-secondary text-xs text-secondary-foreground">Not saved yet</Badge>}
          </div>
        </div>
        <Select
          value={rule.strategy}
          onChange={(e) => onChange({ strategy: e.target.value as Strategy })}
          disabled={!canManage}
          className="h-8 w-36 text-xs"
        >
          {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => (
            <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
          ))}
        </Select>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{STRATEGY_DESCRIPTION[rule.strategy]}</p>

      <EligibleStaffPicker
        idPrefix={`lead-assignment-wa-${rule.ourNumber}`}
        staff={staff}
        eligibleSubs={rule.eligibleSubs}
        canManage={canManage}
        onAdd={(id) => onChange({ eligibleSubs: [...rule.eligibleSubs, id] })}
        onRemove={(id) => onChange({ eligibleSubs: rule.eligibleSubs.filter((s) => s !== id) })}
      />

      {canManage && (
        <div className="mt-4 flex items-center gap-2">
          <Button size="sm" onClick={() => onSave(rule)} disabled={busy || rule.eligibleSubs.length === 0}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={onRemove} disabled={busy}>
            {isDraft ? "Cancel" : "Remove rule"}
          </Button>
          {saved && <span className="text-xs text-emerald-600">Saved</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Per-campaign rules — checked before the channel defaults above (see
 * resolveAutoAssignee in lib/enquiry-service.ts), so a campaign like
 * "Seasonal Detox Hyderabad" can be steered to specific staff regardless of
 * which channel (WhatsApp/email/Google Sheets) it arrived through.
 *
 * Unlike the four fixed channels, campaigns are an open-ended, admin-typed
 * list — this section manages its own add/remove flow instead of a static
 * map, and a rule is deleted server-side the moment its staff list is
 * cleared back to empty (see setCampaignAssignmentRule).
 */
function CampaignsSection({ staff, canManage }: { staff: StaffProfile[]; canManage: boolean }) {
  const [rules, setRules] = useState<CampaignRuleDTO[] | null>(null);
  const [knownCampaigns, setKnownCampaigns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // A rule an admin has started configuring but not saved yet — kept
  // separate from `rules` (which mirrors the server) so a half-filled draft
  // doesn't look like it's already active.
  const [draft, setDraft] = useState<CampaignRuleDTO | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ rules: CampaignRuleDTO[]; knownCampaigns: string[] }>(
        "/api/admin/lead-assignment/campaigns",
      );
      setRules(res.rules);
      setKnownCampaigns(res.knownCampaigns);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaign rules");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(rule: CampaignRuleDTO) {
    if (busySlug || !canManage) return;
    setBusySlug(rule.campaignSlug || rule.campaignLabel);
    try {
      await api.put("/api/admin/lead-assignment/campaigns", {
        campaignLabel: rule.campaignLabel,
        strategy: rule.strategy,
        eligibleSubs: rule.eligibleSubs,
      });
      setDraft(null);
      setSaved(rule.campaignLabel);
      setTimeout(() => setSaved((s) => (s === rule.campaignLabel ? null : s)), 2000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save campaign rule");
    } finally {
      setBusySlug(null);
    }
  }

  function startAdding() {
    const label = newLabel.trim();
    if (!label) return;
    if (rules?.some((r) => r.campaignLabel.toLowerCase() === label.toLowerCase())) {
      setError(`"${label}" already has a rule below.`);
      return;
    }
    setDraft({ campaignSlug: "", campaignLabel: label, strategy: "round_robin", eligibleSubs: [] });
    setNewLabel("");
  }

  const configuredLabels = new Set((rules ?? []).map((r) => r.campaignLabel.toLowerCase()));
  const addableCampaigns = knownCampaigns.filter((c) => !configuredLabels.has(c.toLowerCase()));

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
          <Megaphone className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Campaign-based assignment</h3>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
            Route a specific ad campaign&apos;s leads to specific staff, regardless of channel. Takes
            priority over the channel defaults above whenever a lead&apos;s campaign matches a rule here.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-4 space-y-4">
        {rules === null ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {rules.map((rule) => (
              <CampaignRuleCard
                key={rule.campaignSlug}
                rule={rule}
                staff={staff}
                canManage={canManage}
                busy={busySlug === rule.campaignSlug}
                saved={saved === rule.campaignLabel}
                onChange={(patch) => {
                  const next = { ...rule, ...patch };
                  setRules((prev) => prev?.map((r) => (r.campaignSlug === rule.campaignSlug ? next : r)) ?? prev);
                }}
                onSave={(next) => save(next)}
                onRemove={() => save({ ...rule, eligibleSubs: [] })}
              />
            ))}

            {draft && (
              <CampaignRuleCard
                rule={draft}
                staff={staff}
                canManage={canManage}
                busy={busySlug === draft.campaignLabel}
                saved={false}
                isDraft
                onChange={(patch) => setDraft((d) => (d ? { ...d, ...patch } : d))}
                onSave={(next) => save(next)}
                onRemove={() => setDraft(null)}
              />
            )}

            {rules.length === 0 && !draft && (
              <p className="text-xs text-muted-foreground">No campaign rules configured yet.</p>
            )}
          </>
        )}

        {canManage && !draft && (
          <div className="flex gap-2 border-t border-border pt-4">
            <Input
              list="lead-assignment-known-campaigns"
              value={newLabel}
              placeholder="Campaign name…"
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  startAdding();
                }
              }}
            />
            <datalist id="lead-assignment-known-campaigns">
              {addableCampaigns.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <Button variant="outline" onClick={startAdding} disabled={!newLabel.trim()}>
              <Plus className="h-4 w-4" />
              Add campaign rule
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function CampaignRuleCard({
  rule,
  staff,
  canManage,
  busy,
  saved,
  isDraft,
  onChange,
  onSave,
  onRemove,
}: {
  rule: CampaignRuleDTO;
  staff: StaffProfile[];
  canManage: boolean;
  busy: boolean;
  saved: boolean;
  isDraft?: boolean;
  onChange: (patch: Partial<CampaignRuleDTO>) => void;
  onSave: (rule: CampaignRuleDTO) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">{rule.campaignLabel}</h4>
            {isDraft && <Badge className="bg-secondary text-xs text-secondary-foreground">Not saved yet</Badge>}
          </div>
        </div>
        <Select
          value={rule.strategy}
          onChange={(e) => onChange({ strategy: e.target.value as Strategy })}
          disabled={!canManage}
          className="h-8 w-36 text-xs"
        >
          {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => (
            <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
          ))}
        </Select>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{STRATEGY_DESCRIPTION[rule.strategy]}</p>

      <EligibleStaffPicker
        idPrefix={`lead-assignment-campaign-${rule.campaignSlug || rule.campaignLabel}`}
        staff={staff}
        eligibleSubs={rule.eligibleSubs}
        canManage={canManage}
        onAdd={(id) => onChange({ eligibleSubs: [...rule.eligibleSubs, id] })}
        onRemove={(id) => onChange({ eligibleSubs: rule.eligibleSubs.filter((s) => s !== id) })}
      />

      {canManage && (
        <div className="mt-4 flex items-center gap-2">
          <Button size="sm" onClick={() => onSave(rule)} disabled={busy || rule.eligibleSubs.length === 0}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
          {!isDraft && (
            <Button size="sm" variant="outline" onClick={onRemove} disabled={busy}>
              Remove rule
            </Button>
          )}
          {isDraft && (
            <Button size="sm" variant="outline" onClick={onRemove} disabled={busy}>
              Cancel
            </Button>
          )}
          {saved && <span className="text-xs text-emerald-600">Saved</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Per-tag rules — checked AFTER the campaign rules and before the channel
 * defaults (see resolveAutoAssignee in lib/enquiry-service.ts).
 *
 * Below campaigns on purpose: a lead belongs to exactly one campaign, but it
 * can arrive carrying several tags, so a tag match is the looser of the two
 * signals. When more than one tag rule matches, `priority` decides — lower
 * first — rather than leaving it to whichever tag happened to sort first.
 *
 * Routes on the tags a lead HAS AT CREATION: the ones the caller supplies
 * plus the system tags worked out from the lead itself (foreign, revisit,
 * age band, source:, campaign:). Auto-tags derived from a later inbound
 * message are excluded on purpose — they land after an owner has been
 * chosen, and quietly reassigning a lead somebody has already started
 * working would be worse than not routing it at all.
 */
function TagsSection({ staff, canManage }: { staff: StaffProfile[]; canManage: boolean }) {
  const [rules, setRules] = useState<TagRuleDTO[] | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState<TagRuleDTO | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ rules: TagRuleDTO[]; knownTags: string[] }>(
        "/api/admin/lead-assignment/tags",
      );
      setRules(res.rules);
      setKnownTags(res.knownTags);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tag rules");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(rule: TagRuleDTO) {
    if (busyTag || !canManage) return;
    setBusyTag(rule.tag || rule.label);
    try {
      await api.put("/api/admin/lead-assignment/tags", {
        label: rule.label,
        strategy: rule.strategy,
        eligibleSubs: rule.eligibleSubs,
        priority: rule.priority,
      });
      setDraft(null);
      setSaved(rule.label);
      setTimeout(() => setSaved((v) => (v === rule.label ? null : v)), 2000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save tag rule");
    } finally {
      setBusyTag(null);
    }
  }

  function startAdding() {
    const label = newLabel.trim();
    if (!label) return;
    if (rules?.some((r) => r.label.toLowerCase() === label.toLowerCase())) {
      setError(`"${label}" already has a rule below.`);
      return;
    }
    setDraft({ tag: "", label, strategy: "round_robin", eligibleSubs: [], priority: 0 });
    setNewLabel("");
  }

  const configured = new Set((rules ?? []).map((r) => r.label.toLowerCase()));
  const addable = knownTags.filter((t) => !configured.has(t.toLowerCase()));

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <TagIcon className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Tag-based assignment</h3>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
            Route leads carrying a tag to specific staff. Covers the tags a lead arrives with and
            the ones the system works out for itself — <b>foreign</b>, revisit, age band, source
            and campaign. A tag added later, by hand or by auto-tagging, does not reassign a lead
            somebody is already working. Checked after campaign rules and before the channel defaults.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-4 space-y-4">
        {rules === null ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {rules.map((rule) => (
              <TagRuleCard
                key={rule.tag}
                rule={rule}
                staff={staff}
                canManage={canManage}
                busy={busyTag === rule.tag}
                saved={saved === rule.label}
                showPriority={rules.length > 1}
                matchesNoLead={knownTags.length > 0 && !knownTags.some((t) => slugifyTag(t) === rule.tag)}
                onChange={(patch) => {
                  const next = { ...rule, ...patch };
                  setRules((prev) => prev?.map((r) => (r.tag === rule.tag ? next : r)) ?? prev);
                }}
                onSave={(next) => save(next)}
                onRemove={() => save({ ...rule, eligibleSubs: [] })}
              />
            ))}

            {draft && (
              <TagRuleCard
                rule={draft}
                staff={staff}
                canManage={canManage}
                busy={busyTag === draft.label}
                saved={false}
                isDraft
                showPriority={(rules?.length ?? 0) > 0}
                onChange={(patch) => setDraft((d) => (d ? { ...d, ...patch } : d))}
                onSave={(next) => save(next)}
                onRemove={() => setDraft(null)}
              />
            )}

            {rules.length === 0 && !draft && (
              <p className="text-xs text-muted-foreground">No tag rules configured yet.</p>
            )}
          </>
        )}

        {canManage && !draft && (
          <div className="flex gap-2 border-t border-border pt-4">
            {/* A picker, not free text. A rule whose tag matches nothing is
                silently dead — indistinguishable from a working one on this
                screen — and that is exactly how a "foreign-guest" rule sat
                here for weeks routing no leads while the real tag was
                "foreign". You cannot mistype a tag you had to choose. */}
            <Select
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              disabled={addable.length === 0}
            >
              <option value="">
                {addable.length ? "Choose a tag…" : "Every tag already has a rule"}
              </option>
              {addable.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Button variant="outline" onClick={startAdding} disabled={!newLabel.trim()}>
              <Plus className="h-4 w-4" />
              Add tag rule
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function TagRuleCard({
  rule,
  staff,
  canManage,
  busy,
  saved,
  isDraft,
  showPriority,
  matchesNoLead,
  onChange,
  onSave,
  onRemove,
}: {
  rule: TagRuleDTO;
  staff: StaffProfile[];
  canManage: boolean;
  busy: boolean;
  saved: boolean;
  isDraft?: boolean;
  /** No active lead carries this tag, so the rule cannot fire. */
  matchesNoLead?: boolean;
  /** Only meaningful once a second rule exists to be ordered against. */
  showPriority: boolean;
  onChange: (patch: Partial<TagRuleDTO>) => void;
  onSave: (rule: TagRuleDTO) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">{rule.label}</h4>
            {isDraft && <Badge className="bg-secondary text-xs text-secondary-foreground">Not saved yet</Badge>}
            {/* A rule keyed on a tag nothing carries routes nothing, and looks
                identical to a working one. Say so rather than let it sit. */}
            {matchesNoLead && !isDraft && (
              <Badge className="bg-amber-100 text-xs text-amber-800">
                No lead has this tag — never fires
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showPriority && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Priority
              <Input
                type="number"
                min={0}
                max={999}
                value={rule.priority}
                disabled={!canManage}
                onChange={(e) => onChange({ priority: Number(e.target.value) || 0 })}
                className="h-8 w-16 text-xs"
              />
            </label>
          )}
          <Select
            value={rule.strategy}
            onChange={(e) => onChange({ strategy: e.target.value as Strategy })}
            disabled={!canManage}
            className="h-8 w-36 text-xs"
          >
            {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => (
              <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
            ))}
          </Select>
        </div>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {STRATEGY_DESCRIPTION[rule.strategy]}
        {showPriority && " Lower priority numbers are tried first when a lead matches several tags."}
      </p>

      <EligibleStaffPicker
        idPrefix={`lead-assignment-tag-${rule.tag || rule.label}`}
        staff={staff}
        eligibleSubs={rule.eligibleSubs}
        canManage={canManage}
        onAdd={(id) => onChange({ eligibleSubs: [...rule.eligibleSubs, id] })}
        onRemove={(id) => onChange({ eligibleSubs: rule.eligibleSubs.filter((s) => s !== id) })}
      />

      {canManage && (
        <div className="mt-4 flex items-center gap-2">
          <Button size="sm" onClick={() => onSave(rule)} disabled={busy || rule.eligibleSubs.length === 0}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={onRemove} disabled={busy}>
            {isDraft ? "Cancel" : "Remove rule"}
          </Button>
          {saved && <span className="text-xs text-emerald-600">Saved</span>}
        </div>
      )}
    </div>
  );
}
