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
/** One row per RECORD. Several rows can share a phone — a family submits one
 *  screening form each and they all resolve to the same guest. */
interface RecordRow {
  recordId: string;
  guestId: string;
  name: string;
  phone: string;
  guestName: string;
  hasDuplicate: boolean;
  updatedAt: string;
}
/** One screening-form submission. A guest can have several — a family shares
 *  a phone number, and Guest.phone is unique. */
interface HealthRecordRow {
  id: string;
  subjectName: string | null;
  hasDuplicate: boolean;
  updatedAt: string;
  record: HealthRecord;
  schemaMismatch: boolean;
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

export function HealthWorkspace({ canEdit }: { canEdit: boolean }) {
  const [q, setQ] = useState("");
  // Default ON: this screen exists to work on health records, and listing
  // every guest in the CRM buried the few hundred that actually have one.
  const [onlyWithRecords, setOnlyWithRecords] = useState(true);
  const [rows, setRows] = useState<GuestRow[]>([]);
  const [recordRows, setRecordRows] = useState<RecordRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which record the detail pane opens on. Set when a record row is clicked;
  // null means "the guest's first", which is what picking a guest gives you.
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(async (term: string, onlyWithRecordsNow: boolean) => {
    setSearching(true);
    try {
      const params = new URLSearchParams({ q: term });
      if (onlyWithRecordsNow) {
        // Records, one row each. Listing guests here showed a family of three
        // as a single line and buried two of their records inside it.
        const data = await api.get<{ items: RecordRow[] }>(`/api/health/records?${params}`);
        setRecordRows(data.items);
        setRows([]);
      } else {
        // Guests, including those with no record — the only way to start one
        // for somebody who has never submitted a form.
        const data = await api.get<{ items: GuestRow[]; total: number }>(`/api/guests?${params}`);
        setRows(data.items);
        setRecordRows([]);
      }
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    clearTimeout(debounce.current);
    // The checkbox settles immediately; only typing is debounced.
    debounce.current = setTimeout(() => search(q, onlyWithRecords), q ? 250 : 0);
    return () => clearTimeout(debounce.current);
  }, [q, onlyWithRecords, search]);

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
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={onlyWithRecords}
              onChange={(e) => setOnlyWithRecords(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-input accent-brand-600"
            />
            Only people with a health record
          </label>
        </div>
        {/* data-scroll-container: real scroller on this screen (<main> doesn't
            scroll here) so overlays can lock it — see ui/sheet.tsx. */}
        <div data-scroll-container className="flex-1 overflow-y-auto p-2">
          {/* Record rows: one per health record, so each family member is
              their own line. Two rows sharing a phone is normal here. */}
          {recordRows.map((r) => (
            <button
              key={r.recordId}
              onClick={() => {
                setSelectedId(r.guestId);
                setSelectedRecordId(r.recordId);
              }}
              className={cn(
                "mb-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                selectedRecordId === r.recordId
                  ? "bg-brand-50 ring-1 ring-brand-200"
                  : "hover:bg-secondary",
              )}
            >
              <Avatar name={r.name} className="h-8 w-8" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">{r.name}</span>
                  {r.hasDuplicate && (
                    <Badge className="shrink-0 bg-amber-100 text-amber-900">Duplicate</Badge>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {r.phone}
                  {/* Only when the record is about somebody other than the
                      guest whose number it arrived on — otherwise it would
                      just repeat the line above. */}
                  {r.name.trim().toLowerCase() !== r.guestName.trim().toLowerCase() &&
                    ` · via ${r.guestName}`}
                </div>
              </div>
              <HeartPulse className="h-4 w-4 shrink-0 text-brand-600" />
            </button>
          ))}
          {rows.map((g) => (
            <button
              key={g.id}
              onClick={() => {
                setSelectedId(g.id);
                setSelectedRecordId(null);
              }}
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
          {!searching && rows.length === 0 && recordRows.length === 0 && (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              {onlyWithRecords ? "No health records found." : "No guests found."}
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
              key={`${selectedId}:${selectedRecordId ?? "first"}`}
              guestId={selectedId}
              initialRecordId={selectedRecordId}
              onRecordChange={setSelectedRecordId}
              canEdit={canEdit}
              // Re-run under the CURRENT filter: saving a record for a guest
              // who had none is exactly what makes them match it.
              onSaved={() => search(q, onlyWithRecords)}
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
  initialRecordId,
  onRecordChange,
  canEdit,
  onSaved,
}: {
  guestId: string;
  /** Open on this record. Null = the guest's first, which is what clicking a
   *  guest (rather than a record) means. */
  initialRecordId: string | null;
  /** Reports the record now open, so the list highlight follows the tabs. */
  onRecordChange: (id: string | null) => void;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [guest, setGuest] = useState<GuestDetail | null>(null);
  const [view, setView] = useState<"record" | "conversation">("record");
  const [record, setRecord] = useState<HealthRecord>(emptyHealthRecord());
  const [records, setRecords] = useState<HealthRecordRow[]>([]);
  // Which record is open. Null means the guest has none and Save creates one.
  const [activeId, setActiveId] = useState<string | null>(null);
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
      api.get<{ records: HealthRecordRow[] }>(`/api/guests/${guestId}/health`),
    ])
      .then(([g, h]) => {
        const rows = h.records ?? [];
        setGuest(g);
        setRecords(rows);
        // Honour the record the list row asked for; fall back to the first if
        // it has since been deleted.
        const open = rows.find((r) => r.id === initialRecordId) ?? rows[0] ?? null;
        setActiveId(open?.id ?? null);
        setRecord(open?.record ?? emptyHealthRecord());
        setExists(rows.length > 0);
        setUpdatedAt(open?.updatedAt ?? null);
        setSchemaMismatch(Boolean(open?.schemaMismatch));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [guestId, initialRecordId]);

  /** Open a different record for the same guest. Deliberately drops any
   *  unsaved edit rather than carrying it across — copying one family
   *  member's answers onto another's record is the exact harm this screen
   *  now exists to prevent. */
  const activeRecord = records.find((r) => r.id === activeId) ?? null;

  function openRecord(row: HealthRecordRow) {
    setActiveId(row.id);
    onRecordChange(row.id);
    setRecord(row.record);
    setUpdatedAt(row.updatedAt);
    setSchemaMismatch(row.schemaMismatch);
    setAckMismatch(false);
    setSavedAt(null);
    setError(null);
  }

  function set<K extends keyof HealthRecord>(k: K, v: HealthRecord[K]) {
    setRecord((r) => ({ ...r, [k]: v }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Only send the acknowledgement when the record was flagged as an outdated
      // shape and the doctor has explicitly confirmed the overwrite.
      // recordId is what stops a save landing on a sibling's record when the
      // guest has more than one; the API refuses an ambiguous write anyway.
      const params = new URLSearchParams();
      if (activeId) params.set("recordId", activeId);
      if (schemaMismatch && ackMismatch) params.set("acknowledgeSchemaMismatch", "true");
      const qs = params.toString();
      const url = `/api/guests/${guestId}/health${qs ? `?${qs}` : ""}`;
      const res = await api.put<{ saved: boolean; recordId: string; updatedAt: string }>(url, record);
      setExists(true);
      setActiveId(res.recordId);
      setRecords((rs) =>
        rs.some((r) => r.id === res.recordId)
          ? rs.map((r) => (r.id === res.recordId ? { ...r, record, updatedAt: res.updatedAt, schemaMismatch: false } : r))
          : [...rs, { id: res.recordId, subjectName: null, hasDuplicate: false, updatedAt: res.updatedAt, record, schemaMismatch: false }],
      );
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
      await api.delete(
        `/api/guests/${guestId}/health${activeId ? `?recordId=${encodeURIComponent(activeId)}` : ""}`,
      );
      // Fall back to whatever record is left rather than blanking the screen:
      // deleting one of a family's records must not look like the guest lost
      // all of them.
      const remaining = records.filter((r) => r.id !== activeId);
      setRecords(remaining);
      const next = remaining[0] ?? null;
      setActiveId(next?.id ?? null);
      setRecord(next?.record ?? emptyHealthRecord());
      setExists(remaining.length > 0);
      setUpdatedAt(next?.updatedAt ?? null);
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
              {canEdit && (
                <Button
                  variant="secondary"
                  onClick={save}
                  disabled={saving || (schemaMismatch && !ackMismatch)}
                  className="bg-white text-brand-700 hover:bg-white/90"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {exists ? "Save changes" : "Create record"}
                </Button>
              )}
              {canEdit && exists && (
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

      {/* Save and Delete are already hidden without health.edit, but a form
          full of editable-looking fields still reads as one you can change.
          Said plainly instead. */}
      {view === "record" && !canEdit && (
        <div className="no-print border-b border-border bg-secondary/50 px-6 py-2 text-sm text-muted-foreground">
          Read-only — you can view this record but not change it.
        </div>
      )}

      {/* Record picker — only when there is a choice to make. A family shares
          one phone and Guest.phone is unique, so several people's screening
          forms legitimately land on one guest; each is its own record and the
          subject name is the only thing that tells them apart. */}
      {view === "record" && records.length > 1 && (
        <div className="no-print flex flex-wrap items-center gap-2 border-b border-border bg-secondary/40 px-6 py-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {records.length} records on this number
          </span>
          {records.map((r, i) => (
            <button
              key={r.id}
              onClick={() => openRecord(r)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
                r.id === activeId
                  ? "border-brand-300 bg-brand-50 font-medium text-brand-800"
                  : "border-border bg-background text-muted-foreground hover:bg-secondary",
              )}
            >
              {r.subjectName ?? `Record ${i + 1}`}
              {r.hasDuplicate && (
                <Badge className="bg-amber-100 text-amber-900">Duplicate</Badge>
              )}
            </button>
          ))}
        </div>
      )}

      {/* The open record is about someone other than the guest whose page
          this is — worth saying plainly, since everything else on screen is
          headed with the guest's name. */}
      {view === "record" && activeRecord?.subjectName &&
        activeRecord.subjectName.trim().toLowerCase() !== guest?.fullName.trim().toLowerCase() && (
        <div className="no-print border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900">
          This record is for <strong>{activeRecord.subjectName}</strong>, submitted from{" "}
          {guest?.fullName}&apos;s number.
        </div>
      )}

      {view === "record" && activeRecord?.hasDuplicate && (
        <div className="no-print border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900">
          More than one screening form was submitted for this person. Both are kept — decide
          whether the extra one is a correction or a second visit, then delete the one you don&apos;t want.
        </div>
      )}

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
