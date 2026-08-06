"use client";

import { useCallback, useEffect, useState } from "react";
import { Shuffle, Loader2, Plus, X, MessageCircle, Mail, Phone, FileSpreadsheet, Users as UsersIcon } from "lucide-react";
import { Card, Badge, Button, Select, Input } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

type Category = "whatsapp" | "email" | "call" | "google_sheets";
type Strategy = "round_robin" | "least_busy";

interface SettingsDTO {
  category: Category;
  strategy: Strategy;
  eligibleSubs: string[];
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
    blurb: "Who gets rung for a call from an unrecognized number — whoever answers becomes that lead's owner.",
  },
  google_sheets: {
    label: "Google Sheets",
    icon: FileSpreadsheet,
    blurb: "A lead ingested from the n8n Google Sheets workflow (source=google_sheets).",
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
        (Object.keys(CATEGORY_META) as Category[]).map((category) => (
          <CategorySection
            key={category}
            category={category}
            settings={settings[category]}
            staff={staff}
            canManage={canManage}
            busy={busy === category}
            saved={saved === category}
            onStrategyChange={(strategy) => updateLocal(category, { strategy })}
            onAddStaff={(id) => addStaff(category, id)}
            onRemoveStaff={(id) => removeStaff(category, id)}
            onSave={() => save(category)}
          />
        ))
      ) : null}
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
  onAddStaff: (keycloakId: string) => void;
  onRemoveStaff: (keycloakId: string) => void;
  onSave: () => void;
}) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  const restricted = settings.eligibleSubs.length > 0;

  const byId = new Map(staff.map((s) => [s.keycloakId, s]));
  const added = settings.eligibleSubs.map((id) => byId.get(id)).filter((s): s is StaffProfile => Boolean(s));
  const available = staff.filter((s) => !settings.eligibleSubs.includes(s.keycloakId));

  const [input, setInput] = useState("");
  const datalistId = `lead-assignment-staff-${category}`;

  function addByName(name: string) {
    const q = name.trim().toLowerCase();
    if (!q) return;
    const match = available.find((s) => s.displayName.toLowerCase() === q);
    if (!match) return;
    onAddStaff(match.keycloakId);
    setInput("");
  }

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
                  onClick={() => onRemoveStaff(s.keycloakId)}
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
