"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { Button, Input, Select, Textarea, Dialog } from "@/components/ui";
import { api } from "@/lib/client";
import { validatePhone } from "@/lib/validation";
import type { EnquiryDTO } from "@/lib/types";

interface CreateResult {
  enquiry: EnquiryDTO;
  returning: { isReturning: boolean; priorEnquiries: number; lastStage?: string };
}

interface ExistingOpenLead {
  found: boolean;
  stage?: string;
  assignedToName?: string | null;
  guestName?: string;
}

const SOURCES = [
  ["website_form", "Website form"],
  ["whatsapp", "WhatsApp"],
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["referral", "Referral"],
  ["walk_in", "Walk-in"],
  ["phone", "Phone"],
  ["other", "Other"],
] as const;

export function NewLeadDialog({
  onClose,
  onCreated,
  initialPhone,
}: {
  onClose: () => void;
  onCreated: (e: EnquiryDTO) => void;
  /** Pre-fill (e.g. from an unattended-call row) — still editable. */
  initialPhone?: string;
}) {
  const [form, setForm] = useState({
    fullName: "",
    phone: initialPhone ?? "",
    email: "",
    city: "",
    gender: "",
    source: "phone",
    campaignLabel: "",
    referralCode: "",
    note: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [returning, setReturning] = useState<CreateResult["returning"] | null>(null);
  const [existingOpen, setExistingOpen] = useState<ExistingOpenLead | null>(null);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Pre-submit duplicate check: this guest may already have an OPEN lead —
  // possibly owned by a *different* rep who this rep would have no visibility
  // into otherwise (their own leads list only shows their own + unassigned).
  // Found via a real case: a guest already mid-conversation with one rep got
  // a second "New lead" created by another rep 10 minutes later, because
  // nothing surfaced the first one before the second was created.
  useEffect(() => {
    setConfirmDuplicate(false);
    const phoneValid = form.phone && !validatePhone(form.phone);
    if (!phoneValid && !form.email) {
      setExistingOpen(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (phoneValid) params.set("phone", form.phone);
        if (form.email) params.set("email", form.email);
        const res = await api.get<ExistingOpenLead>(`/api/enquiries/check-existing?${params}`);
        setExistingOpen(res.found ? res : null);
      } catch {
        // Non-blocking — a failed check shouldn't stop lead creation.
      }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.phone, form.email]);

  async function submit() {
    const pErr = validatePhone(form.phone);
    if (pErr) { setPhoneError(pErr); return; }
    setPhoneError(null);
    setError(null);
    setSaving(true);
    try {
      const result = await api.post<CreateResult>("/api/enquiries", {
        ...form,
        gender: form.gender || undefined,
        email: form.email || undefined,
      });
      if (result.returning.isReturning) {
        // Surface the returning-guest recognition before closing.
        setReturning(result.returning);
        onCreated(result.enquiry);
      } else {
        onCreated(result.enquiry);
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create lead");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="New lead" className="md:max-w-lg">
      {returning ? (
          <div className="space-y-4 p-4 md:p-6">
            <div className="flex items-start gap-3 rounded-lg border border-brand-200 bg-brand-50 p-4">
              <RefreshCw className="mt-0.5 h-5 w-5 text-brand-600" />
              <div className="text-sm text-brand-800">
                <p className="font-semibold">Existing guest found</p>
                <p className="mt-1">
                  This phone/email already exists ({returning.priorEnquiries} prior
                  enquiry/enquiries
                  {returning.lastStage ? `, last stage: ${returning.lastStage}` : ""}) — their
                  contact details were reused. A new lead ticket was still created for
                  this enquiry, same as always for an existing guest.
                </p>
              </div>
            </div>
            <Button onClick={onClose} className="w-full">
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-3 p-4 md:p-6">
            {error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            {existingOpen && (
              <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 text-sm text-amber-900">
                  <p className="font-semibold">
                    {existingOpen.guestName ?? "This contact"} already has an open lead
                  </p>
                  <p className="mt-0.5">
                    Stage: {existingOpen.stage}
                    {existingOpen.assignedToName ? `, assigned to ${existingOpen.assignedToName}` : ", unassigned"}.
                    Search this phone/email on the Leads page to open it instead of creating another.
                  </p>
                  <label className="mt-2 flex items-center gap-1.5 text-xs font-medium">
                    <input
                      type="checkbox"
                      checked={confirmDuplicate}
                      onChange={(e) => setConfirmDuplicate(e.target.checked)}
                    />
                    Create a new lead for this contact anyway
                  </label>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Full name *">
                <Input value={form.fullName} onChange={(e) => set("fullName", e.target.value)} />
              </Field>
              <Field label="Phone *">
                <Input
                  value={form.phone}
                  onChange={(e) => {
                    set("phone", e.target.value);
                    setPhoneError(validatePhone(e.target.value));
                  }}
                  placeholder="+919876543210"
                  className={phoneError ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {phoneError && (
                  <p className="mt-1 text-xs text-destructive">{phoneError}</p>
                )}
              </Field>
              <Field label="Email">
                <Input value={form.email} onChange={(e) => set("email", e.target.value)} />
              </Field>
              <Field label="City">
                <Input value={form.city} onChange={(e) => set("city", e.target.value)} />
              </Field>
              <Field label="Gender">
                <Select value={form.gender} onChange={(e) => set("gender", e.target.value)}>
                  <option value="">—</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Source *">
                <Select value={form.source} onChange={(e) => set("source", e.target.value)}>
                  {SOURCES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Campaign label">
                <Input value={form.campaignLabel} onChange={(e) => set("campaignLabel", e.target.value)} />
              </Field>
              <Field label="Referral code">
                <Input value={form.referralCode} onChange={(e) => set("referralCode", e.target.value)} />
              </Field>
            </div>
            <Field label="First note">
              <Textarea value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="Context, channel, intent…" />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={saving || !form.fullName || !form.phone || (!!existingOpen && !confirmDuplicate)}
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Create lead
              </Button>
            </div>
          </div>
        )}
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
