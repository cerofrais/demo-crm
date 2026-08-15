"use client";

import { useCallback, useEffect, useState } from "react";
import { Shuffle, Loader2, Plus, X, MessageCircle, Mail, Phone, FileSpreadsheet, Users as UsersIcon, Megaphone } from "lucide-react";
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

interface CampaignRuleDTO {
  campaignSlug: string;
  campaignLabel: string;
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
    blurb: "Who gets rung for a call from an unrecognized number — whoever answered becomes that lead's owner.",
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
              onAddStaff={(id) => addStaff(category, id)}
              onRemoveStaff={(id) => removeStaff(category, id)}
              onSave={() => save(category)}
            />
          ))}
          <CampaignsSection staff={staff} canManage={canManage} />
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
