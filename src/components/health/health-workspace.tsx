"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  RefreshCw,
  HeartPulse,
  Lock,
  Loader2,
  Save,
  ShieldCheck,
  Mail,
  FileText,
  ChevronLeft,
  Printer,
  Trash2,
} from "lucide-react";
import { Input, Card, Badge, Button, Select, Textarea, Avatar, Dialog } from "@/components/ui";
import { ConversationPanel } from "@/components/conversation/conversation-panel";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";
import {
  HEALTH_SECTIONS,
  emptyHealthRecord,
  type HealthRecord,
  type FieldDef,
  type YesNoDetail,
} from "@/lib/health";

interface GuestRow {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  ageGroup: string | null;
  hasHealthProfile: boolean;
}
interface GuestDetail {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  city: string | null;
  gender: string | null;
  age: number | null;
  isReturning: boolean;
}

export function HealthWorkspace() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<GuestRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(async (term: string) => {
    setSearching(true);
    try {
      const data = await api.get<{ items: GuestRow[]; total: number }>(`/api/guests?q=${encodeURIComponent(term)}`);
      setRows(data.items);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => search(q), 250);
    return () => clearTimeout(debounce.current);
  }, [q, search]);

  return (
    <div className="flex h-full">
      {/* Left: guest search — full width on phone, hidden once a guest is picked */}
      <div
        className={cn(
          "no-print flex w-full shrink-0 flex-col border-r border-border bg-background md:w-80",
          selectedId && "hidden md:flex",
        )}
      >
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            {searching && (
              <RefreshCw className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search guest by name / phone…"
              className="pl-8"
            />
          </div>
        </div>
        {/* data-scroll-container: real scroller on this screen (<main> doesn't
            scroll here) so overlays can lock it — see ui/sheet.tsx. */}
        <div data-scroll-container className="flex-1 overflow-y-auto p-2">
          {rows.map((g) => (
            <button
              key={g.id}
              onClick={() => setSelectedId(g.id)}
              className={cn(
                "mb-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                selectedId === g.id ? "bg-brand-50 ring-1 ring-brand-200" : "hover:bg-secondary",
              )}
            >
              <Avatar name={g.fullName} className="h-8 w-8" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {g.fullName}
                </div>
                <div className="truncate text-xs text-muted-foreground">{g.phone}</div>
              </div>
              {g.hasHealthProfile && (
                <HeartPulse className="h-4 w-4 shrink-0 text-brand-600" />
              )}
            </button>
          ))}
          {!searching && rows.length === 0 && (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              No guests found.
            </p>
          )}
        </div>
      </div>

      {/* Right: health record — hidden on phone until a guest is picked */}
      <div
        data-scroll-container
        className={cn(
          "min-w-0 flex-1 overflow-y-auto",
          !selectedId && "hidden md:block",
        )}
      >
        {selectedId ? (
          <>
            <button
              onClick={() => setSelectedId(null)}
              className="no-print flex min-h-[44px] w-full items-center gap-1 border-b border-border bg-background px-4 text-sm text-muted-foreground md:hidden"
            >
              <ChevronLeft className="h-4 w-4" /> Back to guests
            </button>
            <HealthDetail
              key={selectedId}
              guestId={selectedId}
              onSaved={() => search(q)}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
            <Lock className="mb-3 h-8 w-8" />
            <p className="text-sm">Select a guest to view their encrypted health record.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function HealthDetail({
  guestId,
  onSaved,
}: {
  guestId: string;
  onSaved: () => void;
}) {
  const [guest, setGuest] = useState<GuestDetail | null>(null);
  const [view, setView] = useState<"record" | "conversation">("record");
  const [record, setRecord] = useState<HealthRecord>(emptyHealthRecord());
  const [exists, setExists] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // A legacy record whose shape no longer matches the schema is returned as an
  // EMPTY editable form; saving over it would destroy the original (no versioning),
  // so we surface it and require an explicit acknowledgement before writing.
  const [schemaMismatch, setSchemaMismatch] = useState(false);
  const [ackMismatch, setAckMismatch] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setAckMismatch(false);
    Promise.all([
      api.get<GuestDetail>(`/api/guests/${guestId}`),
      api.get<{ exists: boolean; record: HealthRecord; updatedAt: string | null; schemaMismatch?: boolean }>(
        `/api/guests/${guestId}/health`,
      ),
    ])
      .then(([g, h]) => {
        setGuest(g);
        setRecord(h.record);
        setExists(h.exists);
        setUpdatedAt(h.updatedAt);
        setSchemaMismatch(Boolean(h.schemaMismatch));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [guestId]);

  function set<K extends keyof HealthRecord>(k: K, v: HealthRecord[K]) {
    setRecord((r) => ({ ...r, [k]: v }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Only send the acknowledgement when the record was flagged as an outdated
      // shape and the doctor has explicitly confirmed the overwrite.
      const url =
        schemaMismatch && ackMismatch
          ? `/api/guests/${guestId}/health?acknowledgeSchemaMismatch=true`
          : `/api/guests/${guestId}/health`;
      const res = await api.put<{ saved: boolean; updatedAt: string }>(url, record);
      setExists(true);
      setUpdatedAt(res.updatedAt);
      setSavedAt(formatIST(new Date(), { timeStyle: "medium" }));
      setSchemaMismatch(false);
      setAckMismatch(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function deleteRecord() {
    setDeleting(true);
    setError(null);
    try {
      await api.delete(`/api/guests/${guestId}/health`);
      setRecord(emptyHealthRecord());
      setExists(false);
      setUpdatedAt(null);
      setSavedAt(null);
      setConfirmingDelete(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-brand-700 px-6 py-4 text-white">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-sm font-semibold">
            {guest?.fullName.split(/\s+/).slice(0, 2).map((p) => p[0]).join("")}
          </div>
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold">
              {guest?.fullName}
              {guest?.isReturning && (
                <Badge className="bg-white/20 text-white">Returning</Badge>
              )}
            </div>
            <div className="text-sm text-white/80">
              {guest?.phone}
              {guest?.age != null && ` · ${guest.age} yrs`}
              {guest?.gender && ` · ${guest.gender}`}
              {guest?.city && ` · ${guest.city}`}
            </div>
          </div>
        </div>
        <div className="no-print flex items-center gap-3">
          {/* Record ↔ Conversation toggle */}
          <div className="flex rounded-lg bg-white/15 p-0.5 text-sm">
            <button
              onClick={() => setView("record")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1",
                view === "record" ? "bg-white text-brand-700" : "text-white/85",
              )}
            >
              <FileText className="h-3.5 w-3.5" /> Record
            </button>
            <button
              onClick={() => setView("conversation")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1",
                view === "conversation" ? "bg-white text-brand-700" : "text-white/85",
              )}
            >
              <Mail className="h-3.5 w-3.5" /> Conversation
            </button>
          </div>
          {view === "record" && (
            <>
              <Button
                variant="secondary"
                onClick={() => window.print()}
                className="bg-white text-brand-700 hover:bg-white/90"
              >
                <Printer className="h-4 w-4" />
                Print / Save as PDF
              </Button>
              <Button
                variant="secondary"
                onClick={save}
                disabled={saving || (schemaMismatch && !ackMismatch)}
                className="bg-white text-brand-700 hover:bg-white/90"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {exists ? "Save changes" : "Create record"}
              </Button>
              {exists && (
                <Button
                  variant="secondary"
                  onClick={() => setConfirmingDelete(true)}
                  className="bg-white/15 text-white hover:bg-white/25"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {confirmingDelete && (
        <Dialog open onClose={() => setConfirmingDelete(false)} title="Delete health record" className="md:max-w-sm">
          <div className="p-4 md:p-5">
            <p className="text-sm text-muted-foreground">
              This permanently deletes {guest?.fullName}&apos;s encrypted health record. It cannot
              be undone — the screening form will need to be re-entered from scratch.
            </p>
            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={deleteRecord}
                disabled={deleting}
                className="w-full sm:w-auto"
              >
                {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
                Delete record
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {view === "conversation" && (
        <div className="p-4 md:p-6">
          <div className="h-[70dvh]">
            <ConversationPanel guestId={guestId} guestName={guest?.fullName ?? ""} guestGender={guest?.gender} />
          </div>
        </div>
      )}

      <div className={cn("print-area space-y-5 p-6", view !== "record" && "hidden")}>
        {error && (
          <div className="no-print rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {schemaMismatch && (
          <div className="no-print rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-medium">This record was saved in an older format.</p>
            <p className="mt-1">
              The form below shows blank fields — saving now will <strong>replace</strong> the
              original encrypted record, which cannot be recovered. Only proceed if you intend to
              re-enter it from scratch.
            </p>
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={ackMismatch}
                onChange={(e) => setAckMismatch(e.target.checked)}
              />
              I understand and want to replace the old record.
            </label>
          </div>
        )}
        {savedAt && (
          <div className="no-print rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800">
            Saved at {savedAt}. Encrypted and written to the audit log.
          </div>
        )}
        {!exists && !savedAt && (
          <div className="no-print rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            No health record yet — fill the screening below and save to create one.
          </div>
        )}
        {updatedAt && (
          <p className="text-xs text-muted-foreground">
            Last updated {formatIST(updatedAt)}
          </p>
        )}

        {HEALTH_SECTIONS.map((section) => (
          <Card key={section.title} className="p-5">
            <h3 className="mb-4 text-sm font-semibold text-foreground">
              {section.title}
            </h3>
            <div className="grid gap-4 md:grid-cols-2">
              {section.fields.map((f) => (
                <HealthField
                  key={f.key}
                  field={f}
                  record={record}
                  set={set}
                />
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function HealthField({
  field,
  record,
  set,
}: {
  field: FieldDef;
  record: HealthRecord;
  set: <K extends keyof HealthRecord>(k: K, v: HealthRecord[K]) => void;
}) {
  const value = record[field.key];
  const wide = field.type === "textarea" || field.type === "checkboxGroup" || field.type === "boolWithDetails";

  return (
    <label className={cn("block space-y-1", wide && "md:col-span-2")}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {field.label}
      </span>

      {field.type === "text" || field.type === "number" ? (
        <Input
          type={field.type === "number" ? "number" : "text"}
          value={value as string}
          onChange={(e) => set(field.key, e.target.value as never)}
        />
      ) : field.type === "date" ? (
        <Input
          type="date"
          value={value as string}
          onChange={(e) => set(field.key, e.target.value as never)}
        />
      ) : field.type === "textarea" ? (
        <Textarea
          value={value as string}
          onChange={(e) => set(field.key, e.target.value as never)}
        />
      ) : field.type === "yesno" ? (
        <Select
          value={(value as boolean) ? "yes" : "no"}
          onChange={(e) => set(field.key, (e.target.value === "yes") as never)}
        >
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </Select>
      ) : field.type === "select" ? (
        <Select
          value={value as string}
          onChange={(e) => set(field.key, e.target.value as never)}
        >
          <option value="">—</option>
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : field.type === "checkboxGroup" ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {field.options?.map((o) => {
            const arr = (value as string[]) ?? [];
            const on = arr.includes(o);
            return (
              <button
                key={o}
                type="button"
                onClick={() =>
                  set(
                    field.key,
                    (on ? arr.filter((x) => x !== o) : [...arr, o]) as never,
                  )
                }
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  on
                    ? "border-brand-500 bg-brand-500 text-white"
                    : "border-border bg-background text-muted-foreground hover:bg-secondary",
                )}
              >
                {o}
              </button>
            );
          })}
        </div>
      ) : field.type === "boolWithDetails" ? (
        <BoolWithDetails
          value={value as YesNoDetail}
          onChange={(v) => set(field.key, v as never)}
        />
      ) : null}
    </label>
  );
}

function BoolWithDetails({
  value,
  onChange,
}: {
  value: YesNoDetail;
  onChange: (v: YesNoDetail) => void;
}) {
  return (
    <div className="space-y-2">
      <Select
        value={value.flag ? "yes" : "no"}
        onChange={(e) => onChange({ ...value, flag: e.target.value === "yes" })}
      >
        <option value="no">No</option>
        <option value="yes">Yes</option>
      </Select>
      {value.flag && (
        <Input
          value={value.detail}
          placeholder="Details…"
          onChange={(e) => onChange({ ...value, detail: e.target.value })}
        />
      )}
    </div>
  );
}
