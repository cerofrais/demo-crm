"use client";

import { useEffect, useState } from "react";
import { Plus, Loader2, Copy, Check, QrCode } from "lucide-react";
import { Button, Card, Input, Badge, Dialog } from "@/components/ui";
import { api } from "@/lib/client";
import { copyToClipboard } from "@/lib/utils";

interface Referral {
  id: string;
  code: string;
  url: string;
  campaignLabel: string | null;
  maxRedemptions: number;
  redemptionCount: number;
  attachedEnquiries: number;
  isActive: boolean;
  createdAt: string;
}

export function ReferralsManager({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [maxR, setMaxR] = useState("0");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [qr, setQr] = useState<Referral | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setItems(await api.get<Referral[]>("/api/referrals"));
      setError(null);
    } catch (e) {
      // Called fire-and-forget from useEffect — without this a failure was an
      // unhandled rejection and the user just saw an empty list.
      setError(e instanceof Error ? e.message : "Failed to load referral codes");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.post<Referral>("/api/referrals", {
        campaignLabel: label || undefined,
        maxRedemptions: Number(maxR) || 0,
      });
      setItems((prev) => [r, ...prev]);
      setCreating(false);
      setLabel("");
      setMaxR("0");
    } catch (e) {
      // Keep the form open and say why, instead of an unhandled rejection.
      setError(e instanceof Error ? e.message : "Failed to create referral code");
    } finally {
      setSaving(false);
    }
  }

  async function copy(url: string, id: string) {
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New code
          </Button>
        </div>
      )}

      {/* Load failures surface here; create failures render inside the form below. */}
      {error && !creating && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {creating && (
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Campaign label
            </span>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Diwali 2026" className="w-56" />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Max redemptions (0 = ∞)
            </span>
            <Input type="number" value={maxR} onChange={(e) => setMaxR(e.target.value)} className="w-40" />
          </label>
          <Button onClick={create} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Generate
          </Button>
          <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          {error && <p className="w-full text-xs text-destructive">{error}</p>}
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/60 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Campaign</th>
                <th className="px-4 py-3">Redemptions</th>
                <th className="px-4 py-3">Attached</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-mono font-semibold tracking-wider text-brand-700">
                    {r.code}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{r.campaignLabel ?? "—"}</td>
                  <td className="px-4 py-3">
                    {r.redemptionCount}
                    {r.maxRedemptions > 0 ? ` / ${r.maxRedemptions}` : ""}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{r.attachedEnquiries}</td>
                  <td className="px-4 py-3">
                    {r.isActive ? (
                      <Badge className="bg-brand-100 text-brand-700">Active</Badge>
                    ) : (
                      <Badge className="bg-muted text-muted-foreground">Inactive</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => copy(r.url, r.id)}
                        title="Copy link"
                        className="rounded-md p-1.5 hover:bg-secondary"
                      >
                        {copied === r.id ? (
                          <Check className="h-4 w-4 text-brand-600" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </button>
                      <button
                        onClick={() => setQr(r)}
                        title="QR code"
                        className="rounded-md p-1.5 hover:bg-secondary"
                      >
                        <QrCode className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                    No referral codes yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </Card>
      )}

      <Dialog
        open={!!qr}
        onClose={() => setQr(null)}
        title="Referral QR code"
        className="md:max-w-xs"
      >
        {qr && (
          <div className="p-6 text-center">
            <h3 className="mb-1 font-mono text-lg font-semibold tracking-wider text-brand-700">{qr.code}</h3>
            <p className="mb-4 text-xs text-muted-foreground">{qr.campaignLabel ?? "Referral code"}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/referrals/${qr.id}/qr`}
              alt={`QR for ${qr.code}`}
              className="mx-auto h-56 w-56 max-w-full rounded-lg border border-border"
            />
            <p className="mt-3 break-all text-xs text-muted-foreground">{qr.url}</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
