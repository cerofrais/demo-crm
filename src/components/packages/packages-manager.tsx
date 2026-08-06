"use client";

import { useEffect, useState } from "react";
import { Plus, Loader2, Package as PackageIcon, Pencil } from "lucide-react";
import { Button, Card, Input, Select, Badge, Dialog } from "@/components/ui";
import { api } from "@/lib/client";
import { formatINR } from "@/lib/utils";

interface Pkg {
  id: string;
  name: string;
  category: string;
  durationDays: number;
  basePriceINR: number;
  therapies: string[];
  isActive: boolean;
}

const CATEGORY_LABEL: Record<string, string> = {
  residential: "Residential",
  day: "Day",
  corporate: "Corporate",
};

export function PackagesManager({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<Pkg[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Pkg | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setItems(await api.get<Pkg[]>("/api/packages"));
      setError(null);
    } catch (e) {
      // Called fire-and-forget from useEffect — without this a failure was an
      // unhandled rejection and the user just saw an empty list.
      setError(e instanceof Error ? e.message : "Failed to load packages");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function toggleActive(p: Pkg) {
    setError(null);
    try {
      const updated = await api.patch<Pkg>(`/api/packages/${p.id}`, { isActive: !p.isActive });
      setItems((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
    } catch (e) {
      // Without this the card silently never flipped (unhandled rejection).
      setError(e instanceof Error ? e.message : "Failed to update package");
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New package
          </Button>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <Card key={p.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <PackageIcon className="h-5 w-5 text-brand-600" />
                  <Badge className="bg-secondary text-secondary-foreground">
                    {CATEGORY_LABEL[p.category] ?? p.category}
                  </Badge>
                </div>
                {!p.isActive && (
                  <Badge className="bg-muted text-muted-foreground">Inactive</Badge>
                )}
              </div>
              <h3 className="mt-2 text-base font-semibold text-foreground">{p.name}</h3>
              <div className="mt-1 text-2xl font-semibold text-brand-700">
                {formatINR(p.basePriceINR)}
              </div>
              <p className="text-sm text-muted-foreground">
                {p.durationDays} {p.durationDays === 1 ? "day" : "days"}
              </p>
              {p.therapies.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {p.therapies.map((t) => (
                    <span
                      key={t}
                      className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {canManage && (
                <div className="mt-4 flex gap-2 border-t border-border pt-3">
                  <Button variant="outline" size="sm" onClick={() => setEditing(p)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => toggleActive(p)}>
                    {p.isActive ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              )}
            </Card>
          ))}
          {items.length === 0 && (
            <p className="col-span-full py-12 text-center text-sm text-muted-foreground">
              No packages yet.
            </p>
          )}
        </div>
      )}

      {(creating || editing) && (
        <PackageDialog
          pkg={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(p) => {
            setItems((prev) => {
              const exists = prev.some((x) => x.id === p.id);
              return exists ? prev.map((x) => (x.id === p.id ? p : x)) : [p, ...prev];
            });
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function PackageDialog({
  pkg,
  onClose,
  onSaved,
}: {
  pkg: Pkg | null;
  onClose: () => void;
  onSaved: (p: Pkg) => void;
}) {
  const [form, setForm] = useState({
    name: pkg?.name ?? "",
    category: pkg?.category ?? "residential",
    durationDays: String(pkg?.durationDays ?? 7),
    basePriceINR: String(pkg?.basePriceINR ?? ""),
    therapies: (pkg?.therapies ?? []).join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    const body = {
      name: form.name,
      category: form.category,
      durationDays: Number(form.durationDays),
      basePriceINR: Number(form.basePriceINR),
      therapies: form.therapies.split(",").map((t) => t.trim()).filter(Boolean),
    };
    try {
      const saved = pkg
        ? await api.patch<Pkg>(`/api/packages/${pkg.id}`, body)
        : await api.post<Pkg>("/api/packages", body);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={pkg ? "Edit package" : "New package"} className="md:max-w-md">
        <div className="space-y-3 p-4 md:p-6">
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Category">
              <Select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                <option value="residential">Residential</option>
                <option value="day">Day</option>
                <option value="corporate">Corporate</option>
              </Select>
            </Field>
            <Field label="Duration (days)">
              <Input type="number" value={form.durationDays} onChange={(e) => setForm((f) => ({ ...f, durationDays: e.target.value }))} />
            </Field>
          </div>
          <Field label="Base price (INR)">
            <Input type="number" value={form.basePriceINR} onChange={(e) => setForm((f) => ({ ...f, basePriceINR: e.target.value }))} />
          </Field>
          <Field label="Therapies (comma-separated)">
            <Input value={form.therapies} onChange={(e) => setForm((f) => ({ ...f, therapies: e.target.value }))} placeholder="Abhyanga, Shirodhara, Yoga" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={saving || !form.name || !form.basePriceINR}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {pkg ? "Save" : "Create"}
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
