"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageCircle, Plus, Loader2, Pencil, Trash2, RefreshCw,
  Star, ShieldAlert, QrCode, FileText,
  Clock,
} from "lucide-react";
import { Card, Badge, Button, Input, Dialog } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

interface WhatsAppNumberDTO {
  id: string;
  label: string;
  phoneNumber: string | null;
  instanceName: string;
  status: string;
  isDefault: boolean;
  shared: boolean;
  createdAt: string;
  integration: string;
  wabaId: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-gray-100 text-gray-600",
  connecting: "bg-amber-100 text-amber-700",
  connected: "bg-brand-100 text-brand-700",
  disconnected: "bg-destructive/10 text-destructive",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge className={cn("text-xs", STATUS_COLOR[status] ?? "bg-secondary text-secondary-foreground")}>
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function WhatsAppNumbersManager({ canManage }: { canManage: boolean }) {
  const [numbers, setNumbers] = useState<WhatsAppNumberDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<WhatsAppNumberDTO | null>(null);
  const [deleting, setDeleting] = useState<WhatsAppNumberDTO | null>(null);
  const [pairing, setPairing] = useState<WhatsAppNumberDTO | null>(null);
  const [viewingTemplates, setViewingTemplates] = useState<WhatsAppNumberDTO | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNumbers(await api.get<WhatsAppNumberDTO[]>("/api/admin/whatsapp/numbers"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load numbers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function setDefault(n: WhatsAppNumberDTO) {
    if (!canManage) return;
    setNumbers((prev) => prev.map((x) => ({ ...x, isDefault: x.id === n.id })));
    try {
      await api.patch(`/api/admin/whatsapp/numbers/${n.id}`, { isDefault: true });
    } catch {
      load();
    }
  }

  async function toggleShared(n: WhatsAppNumberDTO) {
    if (!canManage) return;
    setNumbers((prev) => prev.map((x) => (x.id === n.id ? { ...x, shared: !x.shared } : x)));
    try {
      await api.patch(`/api/admin/whatsapp/numbers/${n.id}`, { shared: !n.shared });
    } catch {
      load();
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    await api.delete(`/api/admin/whatsapp/numbers/${deleting.id}`);
    setDeleting(null);
    load();
  }

  return (
    <div>
      <div className="flex items-center justify-between p-6 pb-0">
        <p className="text-xs text-muted-foreground">{numbers.length} number{numbers.length === 1 ? "" : "s"}</p>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> Add number
          </Button>
        )}
      </div>

      <div className="p-6">
        <Card className="overflow-hidden">
          {loading && !numbers.length ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <MessageCircle className="mr-2 h-5 w-5 animate-pulse" /> Loading numbers…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
              <ShieldAlert className="h-10 w-10 opacity-30" />
              <p className="max-w-md text-sm">{error}</p>
              <Button size="sm" variant="outline" onClick={load}>Retry</Button>
            </div>
          ) : !numbers.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <MessageCircle className="h-10 w-10 opacity-20" />
              <p>No WhatsApp numbers connected yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    {["Label", "Phone", "Status", "Default", "Shared", "Actions"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {numbers.map((n) => (
                    <tr key={n.id} className="hover:bg-muted/20">
                      <td className="px-3 py-2.5 font-medium">
                        {n.label}
                        {n.integration === "cloud_api" && (
                          <Badge className="ml-1.5 bg-sky-100 text-sky-700 text-[10px]">Cloud API</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{n.phoneNumber ?? "—"}</td>
                      <td className="px-3 py-2.5"><StatusBadge status={n.status} /></td>
                      <td className="px-3 py-2.5">
                        {n.isDefault ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-brand-700">
                            <Star className="h-3.5 w-3.5 fill-current" /> Default
                          </span>
                        ) : canManage ? (
                          <button
                            onClick={() => setDefault(n)}
                            className="text-xs text-muted-foreground hover:text-foreground"
                            disabled={n.status !== "connected"}
                          >
                            Set as default
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => toggleShared(n)}
                          disabled={!canManage}
                          title={
                            canManage
                              ? (n.shared ? "Offered to staff as a send-from option — click to hide" : "Hidden from staff — click to offer it again")
                              : undefined
                          }
                          className={cn(
                            "rounded px-1.5 py-0.5 text-xs font-medium",
                            n.shared ? "bg-brand-100 text-brand-700" : "bg-gray-100 text-gray-500",
                            !canManage && "cursor-default",
                          )}
                        >
                          {n.shared ? "Shared" : "Hidden"}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          {canManage && n.integration !== "cloud_api" && n.status !== "connected" && (
                            <button onClick={() => setPairing(n)} className="text-muted-foreground hover:text-foreground" title="Connect / show QR">
                              <QrCode className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canManage && n.integration !== "cloud_api" && n.status === "connected" && (
                            <button onClick={() => setPairing(n)} className="text-muted-foreground hover:text-foreground" title="Reconnect">
                              <RefreshCw className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {n.integration === "cloud_api" && (
                            <button onClick={() => setViewingTemplates(n)} className="text-muted-foreground hover:text-foreground" title="View message templates">
                              <FileText className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canManage && (
                            <>
                              <button onClick={() => setRenaming(n)} className="text-muted-foreground hover:text-foreground" title="Rename">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button onClick={() => setDeleting(n)} className="text-muted-foreground hover:text-destructive" title="Delete">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {createOpen && (
        <AddNumberModal
          onClose={() => setCreateOpen(false)}
          onCreated={(n) => {
            setCreateOpen(false);
            load();
            // A Cloud API number is already connected on creation — nothing
            // to pair, unlike a fresh Baileys instance waiting on a QR scan.
            if (n.integration !== "cloud_api") setPairing(n);
          }}
        />
      )}

      {renaming && (
        <RenameModal
          number={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => { setRenaming(null); load(); }}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete number"
          message={`Remove ${deleting.label} (${deleting.phoneNumber ?? "not connected"})? Message history already sent through it is kept, but the number will stop receiving new messages.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        />
      )}

      {pairing && (
        <PairModal
          number={pairing}
          onClose={() => setPairing(null)}
          onConnected={() => { setPairing(null); load(); }}
        />
      )}

      {viewingTemplates && (
        <TemplatesModal number={viewingTemplates} onClose={() => setViewingTemplates(null)} />
      )}
    </div>
  );
}

interface WhatsAppTemplateDTO {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
}

const TEMPLATE_STATUS_COLOR: Record<string, string> = {
  APPROVED: "bg-brand-100 text-brand-700",
  PENDING: "bg-amber-100 text-amber-700",
  REJECTED: "bg-destructive/10 text-destructive",
  IN_APPEAL: "bg-amber-100 text-amber-700",
  PAUSED: "bg-gray-100 text-gray-600",
};

function TemplatesModal({ number, onClose }: { number: WhatsAppNumberDTO; onClose: () => void }) {
  const [templates, setTemplates] = useState<WhatsAppTemplateDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<WhatsAppTemplateDTO[]>(`/api/admin/whatsapp/numbers/${number.id}/templates`)
      .then(setTemplates)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load templates"));
  }, [number.id]);

  return (
    <Dialog open onClose={onClose} title={`${number.label} — message templates`} className="md:max-w-lg">
      <div className="p-4 md:p-5">
        <p className="mb-3 text-xs text-muted-foreground">
          Only <span className="font-medium text-foreground">APPROVED</span> templates can be used to
          start a bulk send. hello_world is Meta&apos;s default test template — useful to confirm the
          number can send before your own templates finish review.
        </p>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !templates ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : templates.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No templates found for this account.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  {["Name", "Category", "Language", "Status"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td className="px-3 py-2 font-medium">{t.name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{t.category}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{t.language}</td>
                    <td className="px-3 py-2">
                      <Badge className={cn("text-[10px]", TEMPLATE_STATUS_COLOR[t.status] ?? "bg-secondary text-secondary-foreground")}>
                        {t.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}

function AddNumberModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (n: WhatsAppNumberDTO) => void;
}) {
  const [mode, setMode] = useState<"baileys" | "cloud_api">("baileys");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave =
    label.trim() && (mode === "baileys" || (token.trim() && phoneNumberId.trim() && wabaId.trim()));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const number = await api.post<WhatsAppNumberDTO>("/api/admin/whatsapp/numbers", {
        label,
        ...(mode === "cloud_api"
          ? { cloudApi: { token: token.trim(), phoneNumberId: phoneNumberId.trim(), wabaId: wabaId.trim() } }
          : {}),
      });
      onCreated(number);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSaving(false);
    }
  }

  return (
    // Shared Dialog: portal + Esc + focus trap/restore + scroll lock, and a
    // max-h with internal scroll so the actions stay reachable on short viewports.
    <Dialog open onClose={onClose} title="Add WhatsApp number" className="md:max-w-sm">
      <div className="space-y-3 p-4 md:p-5">
        <div className="flex gap-1.5 rounded-md bg-secondary/50 p-1">
          <button
            type="button"
            onClick={() => setMode("baileys")}
            className={cn(
              "flex-1 rounded px-2 py-1.5 text-xs font-medium",
              mode === "baileys" ? "bg-background shadow-sm" : "text-muted-foreground",
            )}
          >
            QR code
          </button>
          <button
            type="button"
            onClick={() => setMode("cloud_api")}
            className={cn(
              "flex-1 rounded px-2 py-1.5 text-xs font-medium",
              mode === "cloud_api" ? "bg-background shadow-sm" : "text-muted-foreground",
            )}
          >
            Official Cloud API
          </button>
        </div>
        <Field label="Label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Front Office" />
        </Field>
        {mode === "baileys" ? (
          <p className="text-xs text-muted-foreground">
            You&apos;ll scan a QR code with the WhatsApp phone this number belongs to on the next step.
            Unofficial protocol — carries a real ban risk for bulk/automated sending, use for low-volume
            rep-driven chats.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              For a number already registered with Meta&apos;s official WhatsApp Business Platform — safe
              for bulk/marketing sends, but only approved message templates can be used outside an open chat.
            </p>
            <Field label="Access token">
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Permanent System User token" type="password" />
            </Field>
            <Field label="Phone Number ID">
              <Input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="From Meta's WhatsApp API Setup page" />
            </Field>
            <Field label="WhatsApp Business Account ID">
              <Input value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="WABA ID" />
            </Field>
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !canSave}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === "baileys" ? "Create & show QR" : "Connect"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RenameModal({
  number, onClose, onSaved,
}: {
  number: WhatsAppNumberDTO;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(number.label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/admin/whatsapp/numbers/${number.id}`, { label });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Rename number" className="md:max-w-sm">
      <div className="space-y-3 p-4 md:p-5">
        <Field label="Label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !label.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function PairModal({
  number, onClose, onConnected,
}: {
  number: WhatsAppNumberDTO;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [state, setState] = useState<string>("connecting");
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Seconds until this number may ask WhatsApp for another pairing code. The
  // server decides this; the dialog only counts it down and stops asking.
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await api.get<{
          state: string;
          phoneNumber: string | null;
          qrCodeDataUrl: string | null;
          retryAfterSec?: number;
        }>(`/api/admin/whatsapp/numbers/${number.id}/qr?pair=1`);
        if (cancelled) return;
        setState(res.state);
        setCooldown(res.retryAfterSec ?? 0);
        if (res.qrCodeDataUrl) setQr(res.qrCodeDataUrl);
        if (res.state === "open") {
          setPhoneNumber(res.phoneNumber);
          if (timerRef.current) clearInterval(timerRef.current);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load QR code");
      }
    }

    poll();
    timerRef.current = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [number.id]);

  // While cooling down, tick locally rather than polling — asking the server
  // is what makes WhatsApp issue a code, which is the thing being paused.
  useEffect(() => {
    if (cooldown <= 0) return;
    if (timerRef.current) clearInterval(timerRef.current);
    const t = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open onClose={onClose} title={`Connect ${number.label}`} className="md:max-w-sm">
      <div className="p-4 md:p-5">
        {state === "open" ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-brand-700">
              <MessageCircle className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-foreground">Connected{phoneNumber ? ` — ${phoneNumber}` : ""}</p>
            <Button onClick={onConnected} className="mt-2">Done</Button>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Open WhatsApp on the phone for this number → Settings → Linked devices → Link a device, then scan.
            </p>
            <div className="mt-3 flex items-center justify-center rounded-md border border-border bg-secondary/40 p-4">
              {cooldown > 0 ? (
                <div className="flex h-56 w-56 max-w-full flex-col items-center justify-center gap-2 px-3 text-center">
                  <Clock className="h-6 w-6 text-amber-600" />
                  <p className="text-sm font-medium text-foreground">
                    Paused for {Math.floor(cooldown / 60)}:{String(cooldown % 60).padStart(2, "0")}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Three codes went unscanned. WhatsApp reads repeated pairing attempts as
                    automated behaviour and can restrict the number, so this waits before asking
                    for another. Have the phone ready before trying again.
                  </p>
                </div>
              ) : qr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} alt="WhatsApp pairing QR code" className="h-56 w-56 max-w-full" />
              ) : (
                <div className="flex h-56 w-56 max-w-full items-center justify-center text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              )}
            </div>
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
            <div className="mt-4 flex justify-end">
              <Button variant="outline" onClick={onClose}>Close</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function ConfirmModal({
  title, message, confirmLabel, destructive, onCancel, onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onClose={onCancel} title={title} className="md:max-w-sm">
      <div className="p-4 md:p-5">
        <p className="text-sm text-muted-foreground">{message}</p>
        {error && (
          <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            disabled={busy}
            // try/catch/finally: without it a failing API left the button
            // spinning forever with no message and an unhandled rejection.
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Action failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
