"use client";

import { useEffect, useState } from "react";
import { Card, Button, Input } from "@/components/ui";
import { api } from "@/lib/client";
import { validateIndianPhone } from "@/lib/validation";
import { cn } from "@/lib/utils";

interface Profile { phone: string | null; isOnline: boolean }

export function PhoneEditor() {
  const [phone, setPhone] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const [isOnline, setIsOnline] = useState(true);
  const [loadingOnline, setLoadingOnline] = useState(true);
  const [togglingOnline, setTogglingOnline] = useState(false);

  useEffect(() => {
    api.get<Profile>("/api/staff-profiles/me")
      .then((p) => {
        setCurrent(p.phone);
        setPhone(p.phone ?? "");
        setIsOnline(p.isOnline);
      })
      .catch(() => null)
      .finally(() => setLoadingOnline(false));
  }, []);

  async function save() {
    const err = validateIndianPhone(phone.trim());
    if (err) { setMsg({ text: err, ok: false }); return; }
    setSaving(true);
    setMsg(null);
    try {
      const updated = await api.put<Profile>("/api/staff-profiles/me", { phone: phone.trim() || null });
      setCurrent(updated.phone);
      setMsg({ text: "Phone number saved.", ok: true });
    } catch (err: unknown) {
      setMsg({ text: err instanceof Error ? err.message : "Save failed", ok: false });
    } finally {
      setSaving(false);
    }
  }

  async function toggleOnline() {
    const next = !isOnline;
    setIsOnline(next); // optimistic — this drives inbound call routing, keep it snappy
    setTogglingOnline(true);
    try {
      await api.put<Profile>("/api/staff-profiles/me", { isOnline: next });
    } catch {
      setIsOnline(!next); // revert on failure
    } finally {
      setTogglingOnline(false);
    }
  }

  return (
    <Card className="p-6">
      <h3 className="mb-1 text-sm font-semibold">Click-to-Call Phone</h3>
      <p className="mb-4 text-xs text-muted-foreground">
        Your mobile number in E.164 format (e.g.{" "}
        <span className="font-mono">+919876543210</span>). When you click{" "}
        <strong>Call</strong> on a lead, Plivo rings this number first, then
        bridges you to the customer.
      </p>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-xs text-muted-foreground">Phone (E.164)</label>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder="+919876543210"
            className="font-mono"
          />
        </div>
        <Button onClick={save} disabled={saving} size="sm">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {msg && (
        <p className={`mt-2 text-xs ${msg.ok ? "text-green-600" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
      {current && (
        <p className="mt-2 text-xs text-muted-foreground">
          Current:{" "}
          <span className="font-mono font-medium text-foreground">{current}</span>
        </p>
      )}

      <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
        <div>
          <p className="text-sm font-medium text-foreground">Available for inbound calls</p>
          <p className="text-xs text-muted-foreground">
            Off means the CRM will skip you when routing an incoming call. Turn it off
            when you&apos;re on leave or off-shift.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isOnline}
          aria-label="Available for inbound calls"
          disabled={loadingOnline || togglingOnline}
          onClick={toggleOnline}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
            isOnline ? "bg-brand-600" : "bg-secondary",
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
              isOnline ? "translate-x-6" : "translate-x-1",
            )}
          />
        </button>
      </div>
    </Card>
  );
}
