"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  RefreshCw,
  HeartPulse,
  Mail,
  Send,
  Loader2,
  CheckCircle2,
  Trash2,
  Upload,
  Download,
  MessageCircle,
  Paperclip,
  Plus,
  X,
  StopCircle,
  Ban,
  ShieldCheck,
  Pencil,
  LayoutGrid,
  List,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";
import { Input, Card, Badge, Avatar, Button, Select, Textarea, Dialog, RichTextEditor } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, formatINR } from "@/lib/utils";
import { formatTag, sortTags, isSystemTag } from "@/lib/lead-tags";
import { formatPackageForEmail } from "@/lib/packages";
import { TemplatePicker } from "@/components/messaging/template-picker";
import { PackagePicker } from "@/components/messaging/package-picker";
import { AttachmentPicker, type AttachmentSelection } from "@/components/messaging/attachment-picker";

interface Pkg {
  id: string;
  name: string;
  category: string;
  durationDays: number;
  basePriceINR: number;
  therapies: string[];
  isActive: boolean;
}

interface GuestRow {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  city: string | null;
  gender: string | null;
  ageGroup: string | null;
  isReturning: boolean;
  isBlocked: boolean;
  tags: string[];
  enquiryCount: number;
  hasHealthProfile: boolean;
  /** Newest lead for this guest — live if there is one, else soft-deleted. */
  latestLeadId: string | null;
  latestLeadDeleted: boolean;
}

/** Hover text for a guest row, so where the click goes is obvious first. */
function leadHint(g: GuestRow): string {
  if (!g.latestLeadId) return "No lead for this guest";
  if (g.latestLeadDeleted) return "Open this guest's deleted lead (archive)";
  return g.enquiryCount > 1
    ? `Open this guest's latest lead (${g.enquiryCount} enquiries)`
    : "Open this guest's lead";
}

// ---------------------------------------------------------------------------
// List-view column sorting — client-side, over whatever page of `rows` is
// currently loaded (same scope as the grid view; sorting doesn't fetch the
// rest of a "Load more"d list).
// ---------------------------------------------------------------------------
type SortKey = "fullName" | "phone" | "email" | "city" | "ageGroup" | "enquiryCount";

// ageGroup is a bucket label (ageFromDob/ageGroup in lib/utils), not a raw
// number — alphabetical order would put "35–49" before "50+" before "Under
// 35", which isn't youngest-to-oldest. Ranked explicitly instead; unknown
// ("—") always sorts last regardless of direction, same as a null string
// field would for name/phone/etc.
const AGE_GROUP_ORDER: Record<string, number> = { "Under 35": 0, "35–49": 1, "50+": 2 };

function sortGuestRows(rows: GuestRow[], key: SortKey, dir: "asc" | "desc"): GuestRow[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "enquiryCount") return (a.enquiryCount - b.enquiryCount) * mul;
    if (key === "ageGroup") {
      const av = a.ageGroup ? AGE_GROUP_ORDER[a.ageGroup] ?? 99 : 99;
      const bv = b.ageGroup ? AGE_GROUP_ORDER[b.ageGroup] ?? 99 : 99;
      return (av - bv) * mul;
    }
    const av = a[key] ?? "";
    const bv = b[key] ?? "";
    if (!av && bv) return 1; // blanks last regardless of direction
    if (av && !bv) return -1;
    return av.localeCompare(bv) * mul;
  });
}

function SortableTh({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey | null;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  const active = activeKey === sortKey;
  return (
    <th className="px-3 py-3">
      <button
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        {active ? (
          dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Bulk Email Dialog
// ---------------------------------------------------------------------------
function BulkEmailDialog({
  guests,
  usingSelection,
  onClose,
}: {
  guests: GuestRow[];
  usingSelection: boolean;
  onClose: () => void;
}) {
  const withEmail = guests.filter((g) => g.email);
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [packageId, setPackageId] = useState("");
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState<AttachmentSelection | null>(null);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [uploadCategory, setUploadCategory] = useState<string | null>(null);
  const [result, setResult] = useState<{
    sent: number;
    skipped: number;
    failed: number;
    errors: string[];
  } | null>(null);

  useEffect(() => {
    api.get<Pkg[]>("/api/packages").then(setPackages).catch(() => {});
    // Broadcast attachments/images aren't tied to one guest — "marketing" is
    // the more natural home for them, falling back to "operational" for
    // roles that don't have marketing upload rights.
    api
      .get<{ uploadable: string[] }>("/api/files/meta")
      .then((m) => setUploadCategory(m.uploadable.includes("marketing") ? "marketing" : (m.uploadable.includes("operational") ? "operational" : (m.uploadable[0] ?? null))))
      .catch(() => {});
  }, []);

  const selectedPackage = packages.find((p) => p.id === packageId) ?? null;

  async function uploadDocument(file: File, category: string): Promise<string> {
    const { url, storageKey } = await api.post<{ url: string; storageKey: string }>(
      "/api/files/upload-url",
      { filename: file.name, mimeType: file.type || "application/octet-stream", category, sizeBytes: file.size },
    );
    const put = await fetch(url, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    const confirmed = await api.post<{ id: string }>("/api/files/confirm", {
      storageKey,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      category,
      sizeBytes: file.size,
    });
    return confirmed.id;
  }

  async function uploadInlineImage(file: File): Promise<string | null> {
    if (!uploadCategory) return null;
    try {
      return await uploadDocument(file, uploadCategory);
    } catch {
      return null;
    }
  }

  function htmlToPlainText(html: string): string {
    const div = document.createElement("div");
    div.innerHTML = html;
    return (div.innerText || div.textContent || "").trim();
  }

  async function send() {
    const plainBody = htmlToPlainText(bodyHtml);
    if (!subject.trim() || !plainBody) return;
    setSending(true);
    try {
      let attachmentDocumentId: string | undefined;
      if (attachment?.kind === "existing") {
        attachmentDocumentId = attachment.doc.id;
      } else if (attachment?.kind === "new" && uploadCategory) {
        attachmentDocumentId = await uploadDocument(attachment.file, uploadCategory);
      }
      const res = await api.post<{ sent: number; skipped: number; failed: number; errors: string[] }>(
        "/api/guests/bulk-email",
        {
          guestIds: withEmail.map((g) => g.id),
          subject: subject.trim(),
          body: plainBody,
          html: bodyHtml,
          attachmentDocumentId,
          packageId: packageId || undefined,
        },
      );
      setResult(res);
    } catch (e) {
      setResult({ sent: 0, skipped: 0, failed: withEmail.length, errors: [e instanceof Error ? e.message : "Failed"] });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Send Bulk Email" className="md:max-w-lg">
        {result ? (
          /* result screen */
          <div className="flex flex-col items-center gap-3 px-4 py-10 md:px-6">
            <CheckCircle2 className="h-12 w-12 text-emerald-500" />
            <p className="text-lg font-semibold">
              {result.sent} email{result.sent !== 1 ? "s" : ""} sent
            </p>
            {result.skipped > 0 && (
              <p className="text-sm text-muted-foreground">{result.skipped} skipped (no email on file)</p>
            )}
            {result.failed > 0 && (
              <p className="text-sm text-destructive">{result.failed} failed to deliver</p>
            )}
            {result.errors.length > 0 && (
              <div className="w-full max-h-28 overflow-y-auto rounded-md border border-border bg-secondary p-2 text-xs text-muted-foreground">
                {result.errors.map((e, i) => <p key={i}>{e}</p>)}
              </div>
            )}
            <Button variant="outline" onClick={onClose} className="mt-2">Close</Button>
          </div>
        ) : (
          /* compose */
          <div className="space-y-4 px-4 py-5 md:px-6">
            <p className="text-xs text-muted-foreground">
              Sending to {usingSelection ? "your selected" : "all"} {guests.length} guest
              {guests.length !== 1 ? "s" : ""}{usingSelection ? "" : " in the current view"} —{" "}
              {withEmail.length} have an email address
              {guests.length - withEmail.length > 0 && (
                <span className="ml-1 text-amber-600">
                  ({guests.length - withEmail.length} will be skipped — no email)
                </span>
              )}
            </p>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Subject</label>
              <Input
                placeholder="e.g. Exclusive offer for our wellness guests 🌿"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={sending}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-foreground">Message</label>
                <TemplatePicker
                  channel="email"
                  onSelect={(t) => {
                    if (t.subject) setSubject(t.subject);
                    setBodyHtml(t.body.replace(/\n/g, "<br>"));
                  }}
                />
              </div>
              <RichTextEditor
                html={bodyHtml}
                onChange={setBodyHtml}
                placeholder="Write your message here… use {name} to personalize it with each guest's first name."
                disabled={sending}
                className="min-h-[160px]"
                onUploadImage={uploadCategory ? uploadInlineImage : undefined}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Attachment (optional)</label>
              {attachment ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 py-1.5 text-xs">
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">
                    {attachment.kind === "new" ? attachment.file.name : attachment.doc.filename}
                  </span>
                  <button
                    onClick={() => { setAttachment(null); setAttachNote(null); }}
                    className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                    title="Remove attachment"
                    type="button"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                // No guestId: one asset goes to every recipient, so only the
                // shared Resources library is offered — a guest-scoped file
                // would be refused by the bulk-email route anyway.
                uploadCategory && (
                  <AttachmentPicker
                    disabled={sending}
                    title="Attach from Resources, or upload a new file"
                    onSelect={(sel, note) => {
                      setAttachment(sel);
                      setAttachNote(note ?? null);
                    }}
                  />
                )
              )}
              {attachNote && <p className="text-[11px] text-muted-foreground">{attachNote}</p>}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Include package details (optional)</label>
              <Select value={packageId} onChange={(e) => setPackageId(e.target.value)} disabled={sending}>
                <option value="">None</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatINR(p.basePriceINR)} / {p.durationDays}d
                  </option>
                ))}
              </Select>
              {selectedPackage && (
                <pre className="whitespace-pre-wrap rounded-md border border-dashed border-border bg-secondary/40 p-2 text-xs text-muted-foreground">
                  {formatPackageForEmail(selectedPackage)}
                </pre>
              )}
            </div>
            <div className="flex items-center justify-between pt-1">
              <Button variant="outline" onClick={onClose} disabled={sending}>Cancel</Button>
              <Button
                onClick={send}
                disabled={sending || !subject.trim() || !bodyHtml || bodyHtml === "<br>" || withEmail.length === 0}
              >
                {sending ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>
                ) : (
                  <><Send className="h-4 w-4" /> Send to {withEmail.length}</>
                )}
              </Button>
            </div>
          </div>
        )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk CSV Import Dialog
// ---------------------------------------------------------------------------
const SAMPLE_CSV = `firstName,lastName,phone,email,city,gender
Asha,Rao,+919812345678,asha.rao@example.com,Bengaluru,female
Vikram,Singh,+919812345679,,Mumbai,male
`;

function downloadSampleCsv() {
  const blob = new Blob([SAMPLE_CSV], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "guest-import-sample.csv";
  a.click();
  URL.revokeObjectURL(url);
}

interface BulkImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; error: string }[];
  conflicts: {
    row: number;
    type: "duplicate_in_file" | "name_mismatch" | "soft_deleted";
    detail: string;
  }[];
  tag: string;
}

const CONFLICT_LABELS: Record<BulkImportResult["conflicts"][number]["type"], string> = {
  duplicate_in_file: "Duplicate in file",
  name_mismatch: "Name mismatch",
  soft_deleted: "Deleted guest",
};

function BulkImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (tag: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [tag, setTag] = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<BulkImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (tag.trim()) form.append("tag", tag.trim());
      const res = await api.upload<BulkImportResult>("/api/guests/bulk-import", form);
      setResult(res);
      onImported(res.tag);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Bulk Import Guests" className="md:max-w-lg">
      {result ? (
        <div className="flex flex-col items-center gap-3 px-4 py-8 md:px-6">
          <CheckCircle2 className="h-12 w-12 text-emerald-500" />
          <p className="text-lg font-semibold">
            {result.created} created, {result.updated} updated
          </p>
          {result.tag && (
            <p className="text-xs text-muted-foreground">
              Tagged <Badge className={formatTag(result.tag).className}>{formatTag(result.tag).label}</Badge> — filter the list below to review this batch.
            </p>
          )}
          {result.skipped > 0 && (
            <p className="text-sm text-amber-600">
              {result.skipped} row{result.skipped !== 1 ? "s" : ""} skipped
            </p>
          )}
          {result.conflicts.length > 0 && (
            <div className="w-full text-left">
              <p className="mb-1 text-xs font-medium text-amber-600">
                {/* Not all conflicts import — a "Deleted guest" row is
                    skipped, so this can't claim they all went in. */}
                {result.conflicts.length} row{result.conflicts.length !== 1 ? "s" : ""} worth a look
              </p>
              <div className="max-h-32 w-full overflow-y-auto rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                {result.conflicts.map((c, i) => (
                  <p key={i}>Row {c.row} — {CONFLICT_LABELS[c.type]}: {c.detail}</p>
                ))}
              </div>
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="w-full text-left">
              <p className="mb-1 text-xs font-medium text-destructive">
                {result.errors.length} row{result.errors.length !== 1 ? "s" : ""} failed
              </p>
              <div className="max-h-32 w-full overflow-y-auto rounded-md border border-border bg-secondary p-2 text-xs text-muted-foreground">
                {result.errors.map((e, i) => (
                  <p key={i}>Row {e.row}: {e.error}</p>
                ))}
              </div>
            </div>
          )}
          <Button variant="outline" onClick={onClose} className="mt-2">Close</Button>
        </div>
      ) : (
        <div className="space-y-4 px-4 py-5 md:px-6">
          <p className="text-xs text-muted-foreground">
            Columns: <code className="rounded bg-secondary px-1 py-0.5">firstName, lastName, phone, email, city, gender</code>.
            {" "}firstName is required (lastName is optional) and each row needs at least a phone or
            email — phone must be E.164 (e.g. +919812345678). Guests already on file (matched by
            phone/email) are only backfilled where a field is missing, never overwritten.
          </p>
          <button
            type="button"
            onClick={downloadSampleCsv}
            className="flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:underline"
          >
            <Download className="h-3.5 w-3.5" /> Download sample CSV
          </button>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Tag this batch (optional)</label>
            <Input
              placeholder="e.g. spa-expo-2026"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              disabled={uploading}
            />
            <p className="text-[11px] text-muted-foreground">
              Applied to every guest in this file — new or already on file — so you can filter the
              list down to just this batch afterward.
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border py-6 text-sm text-muted-foreground hover:bg-secondary"
          >
            <Upload className="h-4 w-4" />
            {file ? file.name : "Choose a CSV file…"}
          </button>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-between pt-1">
            <Button variant="outline" onClick={onClose} disabled={uploading}>Cancel</Button>
            <Button onClick={upload} disabled={uploading || !file}>
              {uploading ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</>
              ) : (
                <><Upload className="h-4 w-4" /> Import</>
              )}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// New Guest Dialog (guest-only — no Enquiry/lead ticket)
// ---------------------------------------------------------------------------
interface NewGuestResult extends GuestRow {
  alreadyExisted: boolean;
  nameMismatch: boolean;
}

function NewGuestDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (guest: GuestRow) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [gender, setGender] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NewGuestResult | null>(null);

  async function save() {
    if (!fullName.trim() || (!phone.trim() && !email.trim())) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<NewGuestResult>("/api/guests", {
        fullName: fullName.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        city: city.trim() || undefined,
        gender: gender || undefined,
        dateOfBirth: dateOfBirth || undefined,
      });
      setResult(res);
      onCreated(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add guest");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="New Guest" className="md:max-w-md">
      {result ? (
        <div className="flex flex-col items-center gap-3 px-4 py-8 md:px-6">
          <CheckCircle2 className="h-12 w-12 text-emerald-500" />
          <p className="text-lg font-semibold">
            {result.alreadyExisted ? "Guest already on file" : "Guest added"}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {result.alreadyExisted
              ? `A guest matching that phone/email already existed as "${result.fullName}" — no duplicate created, any missing details were backfilled.`
              : `${result.fullName} has been added to the guest directory. No lead ticket was created — this is a guest-only record.`}
          </p>
          {result.nameMismatch && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-center text-xs text-amber-800">
              Note: the existing record&apos;s name doesn&apos;t match what you typed — worth double-checking
              this is the same person.
            </p>
          )}
          <Button variant="outline" onClick={onClose} className="mt-2">Close</Button>
        </div>
      ) : (
        <div className="space-y-3 px-4 py-4 md:px-5">
          <p className="text-xs text-muted-foreground">
            Adds someone to the guest directory directly — no sales lead/enquiry is created. If a
            guest with the same phone or email already exists, this backfills their record instead of
            creating a duplicate.
          </p>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Full name</label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={saving} autoFocus />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Phone</label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+919876543210"
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Email</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={saving}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">At least one of phone or email is required.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">City</label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} disabled={saving} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Gender</label>
              <Select value={gender} onChange={(e) => setGender(e.target.value)} disabled={saving}>
                <option value="">—</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Date of birth</label>
              <Input
                type="date"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
                disabled={saving}
              />
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-between pt-1">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving || !fullName.trim() || (!phone.trim() && !email.trim())}>
              {saving ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Adding…</>
              ) : (
                <><Plus className="h-4 w-4" /> Add guest</>
              )}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit Guest Dialog — updates an existing directory record's core fields.
// dateOfBirth isn't on GuestRow (the list response only returns the derived
// ageGroup), so it's fetched from the detail endpoint on open.
// ---------------------------------------------------------------------------
function EditGuestDialog({
  guest,
  onClose,
  onSaved,
}: {
  guest: GuestRow;
  onClose: () => void;
  onSaved: (guest: GuestRow) => void;
}) {
  const [fullName, setFullName] = useState(guest.fullName);
  const [phone, setPhone] = useState(guest.phone ?? "");
  const [email, setEmail] = useState(guest.email ?? "");
  const [city, setCity] = useState(guest.city ?? "");
  const [gender, setGender] = useState(guest.gender ?? "");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [loadingDob, setLoadingDob] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ dateOfBirth: string | null }>(`/api/guests/${guest.id}`)
      .then((d) => {
        if (!cancelled) setDateOfBirth(d.dateOfBirth ? d.dateOfBirth.slice(0, 10) : "");
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingDob(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guest.id]);

  async function save() {
    if (!fullName.trim() || (!phone.trim() && !email.trim())) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<GuestRow>(`/api/guests/${guest.id}`, {
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        city: city.trim(),
        gender: gender || undefined,
        dateOfBirth: dateOfBirth || undefined,
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update guest");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Edit Guest" className="md:max-w-md">
      <div className="space-y-3 px-4 py-4 md:px-5">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">Full name</label>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={saving} autoFocus />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Phone</label>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+919876543210"
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Email</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={saving} />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">At least one of phone or email is required.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">City</label>
            <Input value={city} onChange={(e) => setCity(e.target.value)} disabled={saving} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Gender</label>
            <Select value={gender} onChange={(e) => setGender(e.target.value)} disabled={saving}>
              <option value="">—</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Date of birth</label>
            <Input
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              disabled={saving || loadingDob}
            />
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center justify-between pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !fullName.trim() || (!phone.trim() && !email.trim())}>
            {saving ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
            ) : (
              <><Pencil className="h-4 w-4" /> Save changes</>
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp Broadcast Dialog
// ---------------------------------------------------------------------------
interface BroadcastStatusDTO {
  id: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  totalCount: number;
  sentCount: number;
  failedCount: number;
  cursor: number;
  createdAt: string;
}

interface NumberOption {
  id: string;
  label: string;
  phoneNumber: string | null;
  isDefault: boolean;
  isMine: boolean;
  integration: string;
}

interface WhatsAppTemplateOption {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  components: { type: string; format?: string; text?: string }[];
  /** Server-decided: this template will send over Meta's Marketing Messages
   *  API rather than the Cloud API. Not a choice — routing follows the
   *  category — so it's shown, not offered. */
  viaMarketingApi?: boolean;
}

/** True when the template's HEADER requires media — the send fails outright
 *  without one (Meta rejects the whole message, see docs/17). */
function templateNeedsHeaderImage(t: WhatsAppTemplateOption): boolean {
  return t.components.some((c) => c.type === "HEADER" && c.format === "IMAGE");
}

/**
 * A template's BODY placeholders, in order of first appearance — either
 * positional ({{1}}, {{2}}, …) or named ({{customer_name}}, …). Meta never
 * mixes the two within one template, so one non-numeric token is enough to
 * treat the whole template as named — matters because named params need a
 * `parameter_name` sent alongside each value, positional ones don't (see
 * broadcast.ts / whatsapp-cloud-api.ts).
 */
function templateBodyParams(t: WhatsAppTemplateOption): { names: string[]; isNamed: boolean } {
  const body = t.components.find((c) => c.type === "BODY")?.text ?? "";
  const tokens = [...body.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]);
  const unique = Array.from(new Set(tokens));
  const isNamed = unique.some((tok) => !/^\d+$/.test(tok));
  const names = isNamed ? unique : unique.sort((a, b) => Number(a) - Number(b));
  return { names, isNamed };
}

function BroadcastProgress({ job, onCancel, cancelling }: {
  job: BroadcastStatusDTO;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const pct = job.totalCount > 0 ? Math.round((job.cursor / job.totalCount) * 100) : 0;
  return (
    <div className="space-y-3 px-4 py-5 md:px-6">
      <p className="text-sm text-foreground">
        {job.status === "queued" ? "Starting…" : "Sending…"} {job.cursor} of {job.totalCount}
        {" "}({job.sentCount} sent{job.failedCount > 0 ? `, ${job.failedCount} failed` : ""})
      </p>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        Paced in the background — safe to close this dialog and come back later.
      </p>
      <div className="flex justify-end">
        <Button variant="outline" onClick={onCancel} disabled={cancelling}>
          {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <StopCircle className="h-4 w-4" />}
          Cancel broadcast
        </Button>
      </div>
    </div>
  );
}

function BroadcastDialog({
  guests,
  usingSelection,
  activeBroadcast,
  onClose,
  onStarted,
  onCancelled,
}: {
  guests: GuestRow[];
  usingSelection: boolean;
  activeBroadcast: BroadcastStatusDTO | null;
  onClose: () => void;
  onStarted: () => void;
  onCancelled: () => void;
}) {
  const withPhone = guests.filter((g) => g.phone);
  const [message, setMessage] = useState("");
  const [delaySec, setDelaySec] = useState("3");
  const [numbers, setNumbers] = useState<NumberOption[]>([]);
  const [numberId, setNumberId] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [templates, setTemplates] = useState<WhatsAppTemplateOption[] | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateParams, setTemplateParams] = useState<string[]>([]);

  const selectedNumber = numbers.find((n) => n.id === numberId);
  const isCloudApi = selectedNumber?.integration === "cloud_api";
  const approvedTemplates = (templates ?? []).filter((t) => t.status === "APPROVED");
  const selectedTemplate = approvedTemplates.find((t) => t.name === templateName);

  useEffect(() => {
    api.get<NumberOption[]>("/api/whatsapp/numbers").then((ns) => {
      setNumbers(ns);
      setNumberId(ns.find((n) => n.isMine)?.id ?? ns.find((n) => n.isDefault)?.id ?? ns[0]?.id ?? "");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setTemplates(null);
    setTemplateName("");
    setTemplateParams([]);
    if (!isCloudApi || !numberId) return;
    setTemplatesLoading(true);
    api
      .get<WhatsAppTemplateOption[]>(`/api/admin/whatsapp/numbers/${numberId}/templates`)
      .then(setTemplates)
      .catch(() => setTemplates([]))
      .finally(() => setTemplatesLoading(false));
  }, [isCloudApi, numberId]);

  useEffect(() => {
    // Reset the header image too — it's only meaningful for whichever
    // template was selected when it was chosen, and a template swap
    // shouldn't silently carry it over to one that may not need it at all.
    setImage(null);
    if (fileRef.current) fileRef.current.value = "";
    if (!selectedTemplate) { setTemplateParams([]); return; }
    setTemplateParams(Array(templateBodyParams(selectedTemplate).names.length).fill(""));
  }, [selectedTemplate]);

  async function start() {
    if (withPhone.length === 0) return;
    if (isCloudApi ? !selectedTemplate : !message.trim()) return;
    if (isCloudApi && selectedTemplate && templateNeedsHeaderImage(selectedTemplate) && !image) return;
    setStarting(true);
    setError(null);
    try {
      let imageDocumentId: string | undefined;
      if (image) {
        const { url, storageKey } = await api.post<{ url: string; storageKey: string }>(
          "/api/files/upload-url",
          {
            filename: image.name,
            mimeType: image.type || "application/octet-stream",
            category: "operational",
            sizeBytes: image.size,
          },
        );
        const put = await fetch(url, {
          method: "PUT",
          body: image,
          headers: { "Content-Type": image.type || "application/octet-stream" },
        });
        if (!put.ok) throw new Error(`Image upload failed (${put.status})`);
        const confirmed = await api.post<{ id: string }>("/api/files/confirm", {
          storageKey,
          filename: image.name,
          mimeType: image.type || "application/octet-stream",
          category: "operational",
          sizeBytes: image.size,
        });
        imageDocumentId = confirmed.id;
      }

      await api.post("/api/guests/broadcast", {
        message: isCloudApi ? "" : message.trim(),
        guestIds: withPhone.map((g) => g.id),
        delaySec: Math.max(1, parseInt(delaySec, 10) || 3),
        numberId: numberId || undefined,
        imageDocumentId,
        template: isCloudApi && selectedTemplate
          ? {
              name: selectedTemplate.name,
              language: selectedTemplate.language,
              bodyParams: templateParams,
              bodyParamNames: templateBodyParams(selectedTemplate).isNamed
                ? templateBodyParams(selectedTemplate).names
                : undefined,
            }
          : undefined,
      });
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the broadcast");
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!activeBroadcast) return;
    setCancelling(true);
    try {
      await api.post(`/api/guests/broadcast/${activeBroadcast.id}/cancel`, {});
      onCancelled();
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="WhatsApp Broadcast" className="md:max-w-lg">
      {activeBroadcast ? (
        <BroadcastProgress job={activeBroadcast} onCancel={cancel} cancelling={cancelling} />
      ) : (
        <div className="space-y-4 px-4 py-5 md:px-6">
          <p className="text-xs text-muted-foreground">
            Sending to {usingSelection ? "your selected" : "all"} {guests.length} guest
            {guests.length !== 1 ? "s" : ""}{usingSelection ? "" : " in the current view"} —{" "}
            {withPhone.length} have a phone number
            {guests.length - withPhone.length > 0 && (
              <span className="ml-1 text-amber-600">
                ({guests.length - withPhone.length} will be skipped — no phone)
              </span>
            )}
            . Sent one at a time in the background, not all at once — use{" "}
            <code className="rounded bg-secondary px-1 py-0.5">{"{name}"}</code> in your message to
            personalize it with each guest&apos;s first name.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Send from</label>
              <Select value={numberId} onChange={(e) => setNumberId(e.target.value)} disabled={starting}>
                {numbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}{n.isMine ? " (You)" : ""}{n.integration === "cloud_api" ? " · Cloud API" : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Delay per message</label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={1}
                  max={300}
                  value={delaySec}
                  onChange={(e) => setDelaySec(e.target.value)}
                  disabled={starting}
                  className="w-20"
                />
                <span className="text-xs text-muted-foreground">sec</span>
              </div>
            </div>
          </div>

          {isCloudApi ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Template</label>
              <p className="text-[11px] text-muted-foreground">
                This number sends via Meta&apos;s official Cloud API — a broadcast has to use an approved
                message template, free text isn&apos;t allowed outside an open chat.
              </p>
              {templatesLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading templates…
                </div>
              ) : approvedTemplates.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  No APPROVED templates yet for this number — check Meta&apos;s review status on the
                  WhatsApp Numbers admin page.
                </p>
              ) : (
                <Select value={templateName} onChange={(e) => setTemplateName(e.target.value)} disabled={starting}>
                  <option value="">Choose a template…</option>
                  {approvedTemplates.map((t) => (
                    <option key={t.id} value={t.name}>{t.name} ({t.category.toLowerCase()}, {t.language})</option>
                  ))}
                </Select>
              )}
              {selectedTemplate?.viaMarketingApi && (
                <p className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[11px] text-violet-800">
                  Sends via Meta&apos;s <strong>Marketing Messages API</strong> — chosen automatically
                  because this is a marketing template. Meta ranks these for engagement, which
                  usually lands more of them than the plain Cloud API.
                </p>
              )}
              {selectedTemplate && (
                <div className="space-y-2 rounded-md border border-dashed border-border bg-secondary/40 p-2.5">
                  {templateNeedsHeaderImage(selectedTemplate) && (
                    <div className="space-y-1">
                      <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Header image (required by this template)
                      </label>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => setImage(e.target.files?.[0] ?? null)}
                      />
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        disabled={starting}
                        className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground hover:bg-secondary"
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                        {image ? image.name : "Choose an image…"}
                        {image && (
                          <X
                            className="ml-auto h-3 w-3 hover:text-destructive"
                            onClick={(e) => { e.stopPropagation(); setImage(null); if (fileRef.current) fileRef.current.value = ""; }}
                          />
                        )}
                      </button>
                    </div>
                  )}
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                    {selectedTemplate.components.find((c) => c.type === "BODY")?.text}
                  </p>
                  {templateParams.map((p, i) => {
                    const paramName = templateBodyParams(selectedTemplate).names[i] ?? String(i + 1);
                    return (
                      <div key={i} className="space-y-0.5">
                        <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {`{{${paramName}}}`}
                        </label>
                        <Input
                          value={p}
                          onChange={(e) => setTemplateParams((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                          placeholder="Value to fill in — e.g. {name} for the guest's first name"
                          disabled={starting}
                          className="h-8 text-xs"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-foreground">Message</label>
                  <div className="flex items-center gap-1.5">
                    <PackagePicker onSelect={(text) => setMessage((prev) => (prev.trim() ? `${prev}\n\n${text}` : text))} />
                    <TemplatePicker channel="whatsapp" onSelect={(t) => setMessage(t.body)} />
                  </div>
                </div>
                <Textarea
                  rows={5}
                  placeholder="Hi {name}, we've got something special for you this month…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  disabled={starting}
                  className="resize-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Image (optional)</label>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => setImage(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={starting}
                  className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:bg-secondary"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {image ? image.name : "Attach an image"}
                  {image && (
                    <X
                      className="ml-1 h-3 w-3 hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); setImage(null); if (fileRef.current) fileRef.current.value = ""; }}
                    />
                  )}
                </button>
              </div>
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-between pt-1">
            <Button variant="outline" onClick={onClose} disabled={starting}>Cancel</Button>
            <Button
              onClick={start}
              disabled={
                starting ||
                withPhone.length === 0 ||
                (isCloudApi
                  ? !selectedTemplate || (templateNeedsHeaderImage(selectedTemplate) && !image)
                  : !message.trim())
              }
            >
              {starting ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Starting…</>
              ) : (
                <><Send className="h-4 w-4" /> Start broadcast to {withPhone.length}</>
              )}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Guest tags editor (inline, per card)
// ---------------------------------------------------------------------------
function GuestTagsEditor({
  guest,
  editable,
  vocab,
  onVocabRefresh,
  onChanged,
}: {
  guest: GuestRow;
  editable: boolean;
  vocab: string[];
  onVocabRefresh: () => void;
  onChanged: (tags: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function addTag(value: string) {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    try {
      const updated = await api.patch<{ tags: string[] }>(`/api/guests/${guest.id}/tags`, { add: v });
      onChanged(updated.tags);
      setInput("");
      setAdding(false);
      onVocabRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(value: string) {
    setBusy(true);
    try {
      const updated = await api.patch<{ tags: string[] }>(`/api/guests/${guest.id}/tags`, { remove: value });
      onChanged(updated.tags);
    } finally {
      setBusy(false);
    }
  }

  if (!editable && guest.tags.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {sortTags(guest.tags).map((t) => {
        const f = formatTag(t);
        const sys = isSystemTag(t);
        return (
          <span
            key={t}
            className={cn("inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium", f.className)}
          >
            {f.label}
            {editable && !sys && (
              <button
                onClick={() => removeTag(t)}
                disabled={busy}
                className="-mr-0.5 flex items-center justify-center p-0.5 hover:opacity-60"
                title="Remove tag"
                aria-label={`Remove tag ${f.label}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </span>
        );
      })}
      {editable &&
        (adding ? (
          <span className="inline-flex items-center gap-1">
            <input
              autoFocus
              list={`guest-tag-vocab-${guest.id}`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag(input);
                }
                if (e.key === "Escape") {
                  setAdding(false);
                  setInput("");
                }
              }}
              onBlur={() => {
                if (!input.trim()) setAdding(false);
              }}
              disabled={busy}
              placeholder="tag…"
              className="h-5 w-20 rounded border border-input bg-background px-1 text-[10px] outline-none focus:border-brand-400"
            />
            <datalist id={`guest-tag-vocab-${guest.id}`}>
              {vocab.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </span>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary"
          >
            <Plus className="h-2.5 w-2.5" /> Tag
          </button>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog
// ---------------------------------------------------------------------------
function DeleteGuestDialog({
  guest,
  onCancel,
  onDeleted,
}: {
  guest: GuestRow;
  onCancel: () => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState<"soft" | "hard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm(mode: "soft" | "hard") {
    setDeleting(mode);
    setError(null);
    try {
      await api.delete(`/api/guests/${guest.id}?mode=${mode}`);
      onDeleted(guest.id);
    } catch (e) {
      // Previously an unhandled rejection: the dialog just stopped spinning.
      setError(e instanceof Error ? e.message : "Failed to delete guest");
    } finally {
      setDeleting(null);
    }
  }

  // Uses the shared Dialog so this gets a portal, Esc, focus trap, scroll lock
  // and the phone bottom-sheet treatment (the hand-rolled modal had none).
  return (
    <Dialog open onClose={onCancel} title="Delete guest" className="md:max-w-sm">
      <div className="p-4 md:p-5">
        <p className="text-sm text-muted-foreground">
          How should {guest.fullName} be removed?
        </p>
        <div className="mt-3 space-y-2">
          <div className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium text-foreground">Soft delete — recommended</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Takes them off search and the leads pipeline. Enquiries, notes, tasks, calls and
              messages stay on record and this can be undone later.
            </p>
          </div>
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">Hard delete — permanent</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Permanently deletes the guest along with every enquiry, note, task, call, WhatsApp
              and email conversation, and document. Cannot be undone.
            </p>
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={Boolean(deleting)}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => confirm("soft")}
            disabled={Boolean(deleting)}
            className="w-full sm:w-auto"
          >
            {deleting === "soft" && <Loader2 className="h-4 w-4 animate-spin" />}
            Soft delete
          </Button>
          <Button
            variant="destructive"
            onClick={() => confirm("hard")}
            disabled={Boolean(deleting)}
            className="w-full sm:w-auto"
          >
            {deleting === "hard" && <Loader2 className="h-4 w-4 animate-spin" />}
            Hard delete
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Block confirmation dialog (unblock is a direct one-click action — see
// the card's Unblock button — only blocking needs a confirm)
// ---------------------------------------------------------------------------
function BlockGuestDialog({
  guest,
  onCancel,
  onBlocked,
}: {
  guest: GuestRow;
  onCancel: () => void;
  onBlocked: (id: string, isBlocked: boolean, tags: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.patch<{ id: string; isBlocked: boolean; tags: string[] }>(
        `/api/guests/${guest.id}/block`,
        { blocked: true },
      );
      onBlocked(res.id, res.isBlocked, res.tags);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to block guest");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onCancel} title="Block guest" className="md:max-w-sm">
      <div className="p-4 md:p-5">
        <p className="text-sm text-muted-foreground">
          Block <span className="font-medium text-foreground">{guest.fullName}</span>? Every future
          WhatsApp message or email from their phone/address will be silently ignored — not shown or
          recorded anywhere in the CRM. Their existing history stays as-is, and this can be undone
          any time from the same button.
        </p>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onCancel} disabled={busy} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy} className="w-full sm:w-auto">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Block guest
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk delete confirmation dialog
// ---------------------------------------------------------------------------
function BulkDeleteGuestsDialog({
  guests,
  activeTags,
  onCancel,
  onDeleted,
}: {
  guests: GuestRow[];
  /** The tag filter bar's currently-active chips, if any. */
  activeTags: string[];
  onCancel: () => void;
  onDeleted: (ids: string[]) => void;
}) {
  const [deleting, setDeleting] = useState<"soft" | "hard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Safety net for "filter by a tag, select all, bulk delete": a guest whose
  // tags aren't fully covered by the active filter carries at least one tag
  // outside what was selected — e.g. filtering by "tag2" alone must not
  // sweep up a guest tagged "tag1, tag2" along with one tagged only "tag2",
  // since selecting just "tag2" was never a decision to touch "tag1"
  // guests too. Selecting every tag a guest has (here, both tag1 and tag2)
  // is what makes them eligible. No active filter at all — e.g. a plain
  // manual checkbox selection — leaves this a no-op.
  const eligible = activeTags.length
    ? guests.filter((g) => g.tags.every((t) => activeTags.includes(t)))
    : guests;
  const excludedCount = guests.length - eligible.length;

  async function confirm(mode: "soft" | "hard") {
    if (!eligible.length) return;
    setDeleting(mode);
    setError(null);
    try {
      const res = await api.post<{ deleted: number; failed: Array<{ id: string; error: string }> }>(
        "/api/guests/bulk-delete",
        { guestIds: eligible.map((g) => g.id), mode },
      );
      const failedIds = new Set(res.failed.map((f) => f.id));
      onDeleted(eligible.filter((g) => !failedIds.has(g.id)).map((g) => g.id));
      if (res.failed.length > 0) {
        setError(`${res.failed.length} of ${eligible.length} couldn't be deleted: ${res.failed[0].error}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete guests");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Dialog open onClose={onCancel} title="Delete guests" className="md:max-w-sm">
      <div className="p-4 md:p-5">
        <p className="text-sm text-muted-foreground">
          How should these {eligible.length} guest{eligible.length !== 1 ? "s" : ""} be removed?
        </p>
        {excludedCount > 0 && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {excludedCount} of {guests.length} selected {excludedCount === 1 ? "guest has" : "guests have"} a tag
            outside the active filter ({activeTags.map((t) => formatTag(t).label).join(", ")}) and won&apos;t be
            touched — select all of a guest&apos;s tags to include them too.
          </p>
        )}
        <div className="mt-3 space-y-2">
          <div className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium text-foreground">Soft delete — recommended</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Takes them off search and the leads pipeline. Enquiries, notes, tasks, calls and
              messages stay on record and this can be undone later.
            </p>
          </div>
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">Hard delete — permanent</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Permanently deletes every one of them along with their enquiries, notes, tasks,
              calls, WhatsApp and email conversations, and documents. Cannot be undone.
            </p>
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={Boolean(deleting)}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => confirm("soft")}
            disabled={Boolean(deleting) || !eligible.length}
            className="w-full sm:w-auto"
          >
            {deleting === "soft" && <Loader2 className="h-4 w-4 animate-spin" />}
            Soft delete
          </Button>
          <Button
            variant="destructive"
            onClick={() => confirm("hard")}
            disabled={Boolean(deleting) || !eligible.length}
            className="w-full sm:w-auto"
          >
            {deleting === "hard" && <Loader2 className="h-4 w-4 animate-spin" />}
            Hard delete
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function GuestSearch({
  canViewHealth,
  canDelete = false,
  canBulkImport = false,
  canBroadcast = false,
  canEditTags = false,
  canBulkEmail = false,
  canCreateGuest = false,
  canBlock = false,
  canEditGuest = false,
  canViewLeads = false,
  canViewDeletedLeads = false,
}: {
  canViewHealth: boolean;
  canDelete?: boolean;
  canBulkImport?: boolean;
  canBroadcast?: boolean;
  canEditTags?: boolean;
  canBulkEmail?: boolean;
  canCreateGuest?: boolean;
  canBlock?: boolean;
  canEditGuest?: boolean;
  canViewLeads?: boolean;
  canViewDeletedLeads?: boolean;
}) {
  const [q, setQ] = useState("");
  // Seeds the search box from ?q= (e.g. the incoming-call banner's "View
  // guest" link) — read directly off the URL rather than useSearchParams()
  // so this doesn't force a Suspense boundary on an otherwise fully
  // client-rendered page.
  useEffect(() => {
    const initialQ = new URLSearchParams(window.location.search).get("q");
    if (initialQ) setQ(initialQ);
  }, []);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [gender, setGender] = useState("");
  const [returning, setReturning] = useState("");
  const [rows, setRows] = useState<GuestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [showBulkEmail, setShowBulkEmail] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showNewGuest, setShowNewGuest] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [activeBroadcast, setActiveBroadcast] = useState<BroadcastStatusDTO | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GuestRow | null>(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [blockTarget, setBlockTarget] = useState<GuestRow | null>(null);
  const [blockBusyId, setBlockBusyId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<GuestRow | null>(null);
  // Manual picks for bulk email/broadcast — keyed by id so a guest stays
  // selected even after a new search/filter drops them out of `rows`,
  // letting staff build a list across multiple searches.
  const [selected, setSelected] = useState<Map<string, GuestRow>>(new Map());
  const [selectingAll, setSelectingAll] = useState(false);
  const [tagVocab, setTagVocab] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [leadNotice, setLeadNotice] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  const router = useRouter();

  // Clicking a guest opens their lead. A live lead goes to the Leads board's
  // drawer (?lead= deep link, same one Tasks uses); a guest whose only lead
  // was soft-deleted goes to the admin-only Deleted Leads archive so their
  // history is still reachable instead of the click dead-ending. Anything we
  // can't open says why rather than doing nothing.
  function openLead(g: GuestRow) {
    setLeadNotice(null);
    if (!g.latestLeadId) {
      setLeadNotice(`${g.fullName} has no lead — they're in the guest directory only.`);
      return;
    }
    if (!g.latestLeadDeleted) {
      if (!canViewLeads) {
        setLeadNotice("You don't have access to the Leads board.");
        return;
      }
      router.push(`/leads?lead=${g.latestLeadId}`);
      return;
    }
    if (!canViewDeletedLeads) {
      setLeadNotice(
        `${g.fullName}'s lead was deleted. Only an admin can open it, from Deleted Leads.`,
      );
      return;
    }
    router.push(`/deleted?lead=${g.latestLeadId}`);
  }

  const refreshTagVocab = useCallback(() => {
    api.get<string[]>("/api/tags").then(setTagVocab).catch(() => {});
  }, []);

  // The distinct set of tags actually applied to a guest right now — drives
  // the filter bar. Scanned server-side (not derived from the loaded page)
  // so a tag only present past guest #200 still shows up as a filter chip.
  const refreshTagOptions = useCallback(() => {
    api.get<string[]>("/api/guests/tags").then(setTagOptions).catch(() => {});
  }, []);

  useEffect(() => {
    if (canEditTags) refreshTagVocab();
  }, [canEditTags, refreshTagVocab]);

  useEffect(() => {
    refreshTagOptions();
  }, [refreshTagOptions]);

  function updateGuestTags(id: string, tags: string[]) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, tags } : r)));
    refreshTagOptions();
  }

  function applyBlockResult(id: string, isBlocked: boolean, tags: string[]) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, isBlocked, tags } : r)));
    refreshTagOptions();
  }

  function applyGuestEdit(updated: GuestRow) {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
    setEditTarget(null);
  }

  async function unblockGuest(g: GuestRow) {
    setBlockBusyId(g.id);
    try {
      const res = await api.patch<{ id: string; isBlocked: boolean; tags: string[] }>(
        `/api/guests/${g.id}/block`,
        { blocked: false },
      );
      applyBlockResult(res.id, res.isBlocked, res.tags);
    } catch {
      // Same silent-no-op-on-failure pattern as GuestTagsEditor's removeTag.
    } finally {
      setBlockBusyId(null);
    }
  }

  function toggleSelect(g: GuestRow) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(g.id)) next.delete(g.id);
      else next.set(g.id, g);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Map());
  }

  // Shared by load/loadMore/selectAllMatching so the three stay in sync —
  // whatever's currently searched/filtered is what each of them operates on.
  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (gender) params.set("gender", gender);
    if (returning) params.set("returning", returning);
    if (activeTags.length) params.set("tags", activeTags.join(","));
    return params;
  }, [q, gender, returning, activeTags]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ items: GuestRow[]; total: number }>(`/api/guests?${filterParams()}`);
      setRows(data.items);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [filterParams]);

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(load, 250);
    return () => clearTimeout(debounce.current);
  }, [load]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const params = filterParams();
      params.set("skip", String(rows.length));
      const data = await api.get<{ items: GuestRow[]; total: number }>(`/api/guests?${params}`);
      setRows((prev) => [...prev, ...data.items]);
      setTotal(data.total);
    } finally {
      setLoadingMore(false);
    }
  }

  // Selects every guest matching the current search/filters — not just
  // what's loaded — so a broadcast can target more than the 200 (or however
  // many) rows currently on screen. Capped at 5000, matching the broadcast
  // API's own recipient limit.
  async function selectAllMatching() {
    setSelectingAll(true);
    try {
      const params = filterParams();
      params.set("take", "5000");
      const data = await api.get<{ items: GuestRow[]; total: number }>(`/api/guests?${params}`);
      setSelected(new Map(data.items.map((g) => [g.id, g])));
    } finally {
      setSelectingAll(false);
    }
  }

  const pollBroadcast = useCallback(async () => {
    if (!canBroadcast) return;
    try {
      setActiveBroadcast(await api.get<BroadcastStatusDTO | null>("/api/guests/broadcast/status"));
    } catch {
      // transient — next poll will retry
    }
  }, [canBroadcast]);

  useEffect(() => {
    if (!canBroadcast) return;
    pollBroadcast();
    const isActive = activeBroadcast && (activeBroadcast.status === "queued" || activeBroadcast.status === "running");
    const interval = setInterval(pollBroadcast, isActive ? 3000 : 15000);
    return () => clearInterval(interval);
  }, [canBroadcast, pollBroadcast, activeBroadcast?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleTag(tag: string) {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  // Tag filtering happens server-side now (see filterParams) — every row in
  // `rows` already matches activeTags, so there's nothing left to filter here.
  const availableTags = useMemo(() => sortTags(tagOptions), [tagOptions]);
  const visible = rows;
  // List view only — the grid has no columns to sort by.
  const sortedVisible = useMemo(
    () => (sortKey ? sortGuestRows(visible, sortKey, sortDir) : visible),
    [visible, sortKey, sortDir],
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  // A manual selection overrides the filtered view for bulk actions; with
  // nothing picked, "everyone currently in view" is the target — unchanged
  // from before this existed.
  const targetGuests = selected.size > 0 ? Array.from(selected.values()) : visible;
  const emailCount = targetGuests.filter((g) => g.email).length;
  const allVisibleSelected = visible.length > 0 && visible.every((g) => selected.has(g.id));

  function toggleSelectAllVisible() {
    setSelected((prev) => {
      const next = new Map(prev);
      if (allVisibleSelected) {
        for (const g of visible) next.delete(g.id);
      } else {
        for (const g of visible) next.set(g.id, g);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col">
      {/* ── Toolbar ── */}
      <div className="border-b border-border bg-background px-4 py-3 md:px-6">
        {/* Search — its own row, always full width, so it never has to
            shrink to share space with the filters/actions below it. */}
        <div className="relative w-full">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          {loading && (
            <RefreshCw className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, phone, email, tag…"
            className="w-full pl-8 md:max-w-sm"
          />
        </div>

        {/* Filters + actions — own row below, wraps instead of shrinking. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={gender} onChange={(e) => setGender(e.target.value)} className="w-32">
            <option value="">All genders</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </Select>

          <Select value={returning} onChange={(e) => setReturning(e.target.value)} className="w-36">
            <option value="">All guests</option>
            <option value="true">Returning only</option>
          </Select>

          {/* View toggle — same shape as the Leads page's Pipeline/List switch. */}
          <div className="flex rounded-lg border border-border bg-secondary p-0.5">
            <button
              onClick={() => setView("grid")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium",
                view === "grid" ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
              title="Grid view"
            >
              <LayoutGrid className="h-4 w-4" /> <span className="hidden sm:inline">Grid</span>
            </button>
            <button
              onClick={() => setView("list")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium",
                view === "list" ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
              title="List view"
            >
              <List className="h-4 w-4" /> <span className="hidden sm:inline">List</span>
            </button>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleSelectAllVisible}
                className="h-3.5 w-3.5 rounded border-input accent-brand-600"
              />
              Select all
            </label>
            <span>
              {rows.length < total ? (
                <>Showing {rows.length} of {total} guests</>
              ) : (
                <>{total} guest{total !== 1 ? "s" : ""}</>
              )}
              {activeTags.length > 0 && " (tag filtered)"}
              {rows.length < total && (
                <>
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="ml-1.5 font-medium text-brand-700 underline-offset-2 hover:underline disabled:opacity-60"
                  >
                    {loadingMore ? "Loading…" : `Load ${Math.min(200, total - rows.length)} more`}
                  </button>
                  <button
                    onClick={selectAllMatching}
                    disabled={selectingAll}
                    className="ml-1.5 font-medium text-brand-700 underline-offset-2 hover:underline disabled:opacity-60"
                    title={total > 5000 ? "Broadcasts cap at 5000 recipients" : undefined}
                  >
                    {selectingAll ? "Selecting…" : `Select all ${Math.min(total, 5000)} matching`}
                  </button>
                </>
              )}
            </span>
            {selected.size > 0 && (
              <span className="flex items-center gap-1 font-medium text-brand-700">
                {selected.size} selected
                <button onClick={clearSelection} className="underline-offset-2 hover:underline">
                  Clear
                </button>
                {canDelete && (
                  <button
                    onClick={() => setShowBulkDelete(true)}
                    title={`Delete ${selected.size} selected guest${selected.size !== 1 ? "s" : ""}`}
                    className="rounded-md p-1 text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            )}
          </div>

          {canCreateGuest && (
            <Button onClick={() => setShowNewGuest(true)}>
              <Plus className="h-4 w-4" />
              New Guest
            </Button>
          )}

          {canBulkEmail && (
            <Button
              variant="outline"
              onClick={() => setShowBulkEmail(true)}
              disabled={emailCount === 0}
              title={emailCount === 0 ? "No guests with an email in current selection/view" : undefined}
            >
              <Mail className="h-4 w-4" />
              Bulk Email
              {emailCount > 0 && (
                <span className="ml-1 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700">
                  {emailCount}
                </span>
              )}
            </Button>
          )}

          {canBulkImport && (
            <Button variant="outline" onClick={() => setShowBulkImport(true)}>
              <Upload className="h-4 w-4" />
              Bulk Import
            </Button>
          )}

          {canBroadcast && (
            <Button
              variant="outline"
              onClick={() => setShowBroadcast(true)}
              className={cn(activeBroadcast && "border-brand-300 bg-brand-50 text-brand-700")}
            >
              <MessageCircle className="h-4 w-4" />
              {activeBroadcast ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {activeBroadcast.cursor}/{activeBroadcast.totalCount}
                </>
              ) : (
                "WhatsApp Broadcast"
              )}
            </Button>
          )}
        </div>
      </div>

      {/* ── Tag filter bar ── */}
      {availableTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-background px-4 py-2 md:px-6">
          <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Tags
          </span>
          {availableTags.map((t) => {
            const f = formatTag(t);
            const active = activeTags.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleTag(t)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-medium transition-all",
                  active
                    ? "bg-brand-700 text-white ring-2 ring-brand-300"
                    : `${f.className} hover:opacity-80`,
                )}
              >
                {f.label}
              </button>
            );
          })}
          {activeTags.length > 0 && (
            <button
              onClick={() => setActiveTags([])}
              className="ml-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
            >
              Clear ({activeTags.length})
            </button>
          )}
        </div>
      )}

      {/* ── Guest grid / list ── */}
      <div className="p-4 md:p-6">
        {leadNotice && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
            <span className="flex-1">{leadNotice}</span>
            <button
              onClick={() => setLeadNotice(null)}
              className="shrink-0 rounded p-0.5 hover:bg-secondary hover:text-foreground"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {!loading && visible.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No guests found.</p>
        ) : view === "list" ? (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/60 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="w-8 px-3 py-3">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        title="Select all"
                        className="h-3.5 w-3.5 rounded border-input accent-brand-600"
                      />
                    </th>
                    <SortableTh label="Name" sortKey="fullName" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Phone" sortKey="phone" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Email" sortKey="email" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="City" sortKey="city" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Age" sortKey="ageGroup" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Enquiries" sortKey="enquiryCount" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <th className="px-3 py-3">Tags</th>
                    <th className="px-3 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedVisible.map((g) => (
                    <tr
                      key={g.id}
                      onClick={() => openLead(g)}
                      title={leadHint(g)}
                      className={cn(
                        "cursor-pointer border-b border-border last:border-0 hover:bg-secondary/40",
                        selected.has(g.id) && "bg-brand-50/60",
                        g.isBlocked && "bg-destructive/5",
                      )}
                    >
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(g.id)}
                          onChange={() => toggleSelect(g)}
                          title="Select for bulk email/broadcast"
                          className="h-3.5 w-3.5 rounded border-input accent-brand-600"
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-foreground">
                          <Avatar name={g.fullName} className="h-6 w-6 text-[10px]" />
                          {g.fullName}
                          {g.isReturning && (
                            <Badge className="bg-brand-100 text-brand-700 shrink-0">Returning</Badge>
                          )}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">{g.phone}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{g.email ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">{g.city ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                        {g.ageGroup && g.ageGroup !== "—" ? g.ageGroup : "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                        {g.enquiryCount}
                        {canViewHealth && g.hasHealthProfile && (
                          <span className="ml-1.5 inline-flex items-center gap-0.5 text-brand-600" title="Health record on file">
                            <HeartPulse className="h-3 w-3" />
                          </span>
                        )}
                      </td>
                      <td className="min-w-[10rem] px-3 py-2.5">
                        <GuestTagsEditor
                          guest={g}
                          editable={canEditTags}
                          vocab={tagVocab}
                          onVocabRefresh={refreshTagVocab}
                          onChanged={(tags) => updateGuestTags(g.id, tags)}
                        />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-0.5">
                          {canEditGuest && (
                            <button
                              onClick={() => setEditTarget(g)}
                              className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                              title="Edit guest"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canBlock && (
                            g.isBlocked ? (
                              <button
                                onClick={() => unblockGuest(g)}
                                disabled={blockBusyId === g.id}
                                className="rounded-md p-1 text-muted-foreground hover:bg-brand-100 hover:text-brand-700 disabled:opacity-50"
                                title="Unblock guest"
                              >
                                {blockBusyId === g.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                )}
                              </button>
                            ) : (
                              <button
                                onClick={() => setBlockTarget(g)}
                                className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                title="Block guest"
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </button>
                            )
                          )}
                          {canDelete && (
                            <button
                              onClick={() => setDeleteTarget(g)}
                              className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              title="Delete guest"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((g) => (
              <Card
                key={g.id}
                onClick={() => openLead(g)}
                title={leadHint(g)}
                className={cn(
                  "cursor-pointer p-4 transition-colors hover:bg-secondary/40",
                  selected.has(g.id) && "border-brand-300 ring-2 ring-brand-300",
                  g.isBlocked && "border-red-300",
                )}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected.has(g.id)}
                    onChange={() => toggleSelect(g)}
                    onClick={(e) => e.stopPropagation()}
                    title="Select for bulk email/broadcast"
                    className="mt-1.5 h-4 w-4 shrink-0 rounded border-input accent-brand-600"
                  />
                  <Avatar name={g.fullName} className="h-10 w-10 text-sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">{g.fullName}</span>
                      {g.isReturning && (
                        <Badge className="bg-brand-100 text-brand-700 shrink-0">Returning</Badge>
                      )}
                      <div
                        className="ml-auto flex shrink-0 items-center gap-0.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {canEditGuest && (
                          <button
                            onClick={() => setEditTarget(g)}
                            className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                            title="Edit guest"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canBlock && (
                          g.isBlocked ? (
                            <button
                              onClick={() => unblockGuest(g)}
                              disabled={blockBusyId === g.id}
                              className="rounded-md p-1 text-muted-foreground hover:bg-brand-100 hover:text-brand-700 disabled:opacity-50"
                              title="Unblock guest"
                            >
                              {blockBusyId === g.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ShieldCheck className="h-3.5 w-3.5" />
                              )}
                            </button>
                          ) : (
                            <button
                              onClick={() => setBlockTarget(g)}
                              className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              title="Block guest"
                            >
                              <Ban className="h-3.5 w-3.5" />
                            </button>
                          )
                        )}
                        {canDelete && (
                          <button
                            onClick={() => setDeleteTarget(g)}
                            className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            title="Delete guest"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground">{g.phone}</div>
                    {g.email && (
                      <div className="truncate text-xs text-muted-foreground">{g.email}</div>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      {g.city && <span>{g.city}</span>}
                      {g.ageGroup && g.ageGroup !== "—" && <span>· {g.ageGroup}</span>}
                      <span>· {g.enquiryCount} enquir{g.enquiryCount === 1 ? "y" : "ies"}</span>
                      {canViewHealth && g.hasHealthProfile && (
                        <span className="inline-flex items-center gap-0.5 text-brand-600">
                          <HeartPulse className="h-3 w-3" /> health on file
                        </span>
                      )}
                    </div>
                    <GuestTagsEditor
                      guest={g}
                      editable={canEditTags}
                      vocab={tagVocab}
                      onVocabRefresh={refreshTagVocab}
                      onChanged={(tags) => updateGuestTags(g.id, tags)}
                    />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {showBulkEmail && (
        <BulkEmailDialog
          guests={targetGuests}
          usingSelection={selected.size > 0}
          onClose={() => setShowBulkEmail(false)}
        />
      )}

      {showBulkImport && (
        <BulkImportDialog
          onClose={() => setShowBulkImport(false)}
          onImported={(tag) => {
            refreshTagOptions();
            if (tag) setActiveTags([tag]);
            else load();
          }}
        />
      )}

      {showNewGuest && (
        <NewGuestDialog
          onClose={() => setShowNewGuest(false)}
          onCreated={(guest) => {
            // Only splice into the currently-loaded list if it isn't already
            // there (a backfilled existing guest may well already be on
            // screen) — bump the total either way so the count stays honest.
            setRows((prev) => (prev.some((r) => r.id === guest.id) ? prev.map((r) => (r.id === guest.id ? guest : r)) : [guest, ...prev]));
            setTotal((prev) => (rows.some((r) => r.id === guest.id) ? prev : prev + 1));
            refreshTagOptions();
          }}
        />
      )}

      {showBroadcast && (
        <BroadcastDialog
          guests={targetGuests}
          usingSelection={selected.size > 0}
          activeBroadcast={activeBroadcast}
          onClose={() => setShowBroadcast(false)}
          onStarted={() => { setShowBroadcast(false); pollBroadcast(); }}
          onCancelled={() => { setShowBroadcast(false); pollBroadcast(); }}
        />
      )}

      {deleteTarget && (
        <DeleteGuestDialog
          guest={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onDeleted={(id) => {
            setRows((prev) => prev.filter((r) => r.id !== id));
            setDeleteTarget(null);
          }}
        />
      )}

      {showBulkDelete && (
        <BulkDeleteGuestsDialog
          guests={targetGuests}
          activeTags={activeTags}
          onCancel={() => setShowBulkDelete(false)}
          onDeleted={(ids) => {
            const idSet = new Set(ids);
            setRows((prev) => prev.filter((r) => !idSet.has(r.id)));
            setTotal((prev) => Math.max(0, prev - ids.length));
            setSelected((prev) => {
              const next = new Map(prev);
              for (const id of ids) next.delete(id);
              return next;
            });
            setShowBulkDelete(false);
          }}
        />
      )}

      {blockTarget && (
        <BlockGuestDialog
          guest={blockTarget}
          onCancel={() => setBlockTarget(null)}
          onBlocked={(id, isBlocked, tags) => {
            applyBlockResult(id, isBlocked, tags);
            setBlockTarget(null);
          }}
        />
      )}

      {editTarget && (
        <EditGuestDialog
          guest={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={applyGuestEdit}
        />
      )}
    </div>
  );
}
