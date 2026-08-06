"use client";

import { useEffect, useState, useCallback } from "react";
import { History, Filter, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Card, Select, Input, Button } from "@/components/ui";
import { ACTION_TYPE_OPTIONS, type ActivityListItemDTO } from "@/lib/activity-log";
import { formatIST } from "@/lib/utils";

interface StaffOption {
  keycloakId: string;
  displayName: string;
}

export default function ActivityLogPage() {
  const [items, setItems] = useState<ActivityListItemDTO[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [actorSub, setActorSub] = useState("");
  const [actionType, setActionType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    fetch("/api/staff-profiles")
      .then((r) => r.json())
      .then((data: StaffOption[]) => setStaff(data))
      .catch(() => {});
  }, []);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (actorSub) params.set("actorSub", actorSub);
      if (actionType) params.set("actionType", actionType);
      if (from) params.set("from", `${from}T00:00:00`);
      if (to) params.set("to", `${to}T23:59:59`);
      if (cursor) params.set("cursor", cursor);
      try {
        const res = await fetch(`/api/reports/activity?${params}`);
        if (!res.ok) throw new Error(`Failed to load activity (${res.status})`);
        const json = await res.json();
        const data = json.data as { items: ActivityListItemDTO[]; nextCursor: string | null };
        setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load activity");
      } finally {
        setLoading(false);
      }
    },
    [actorSub, actionType, from, to],
  );

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title="Activity Log"
        subtitle="Every staff action across the CRM — filter by staff member and date range. Admin/Manager only."
      />

      <div className="flex flex-wrap items-end gap-2 p-4 pb-0 md:p-6 md:pb-0">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Filter className="h-3.5 w-3.5" /> Filters:
        </div>
        <Select value={actorSub} onChange={(e) => setActorSub(e.target.value)} className="w-48 lg:h-8 lg:text-xs">
          <option value="">All staff</option>
          {staff.map((s) => (
            <option key={s.keycloakId} value={s.keycloakId}>{s.displayName}</option>
          ))}
        </Select>
        <Select value={actionType} onChange={(e) => setActionType(e.target.value)} className="w-48 lg:h-8 lg:text-xs">
          <option value="">All actions</option>
          {ACTION_TYPE_OPTIONS.map(([type, label]) => (
            <option key={type} value={type}>{label}</option>
          ))}
        </Select>
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-36 lg:h-8 lg:text-xs"
          aria-label="From date"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-36 lg:h-8 lg:text-xs"
          aria-label="To date"
        />
        <Button size="sm" variant="outline" onClick={() => load()} className="h-8 gap-1 text-xs">
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      <div className="p-4 md:p-6">
        <Card className="overflow-hidden">
          {loading && !items.length ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <History className="mr-2 h-5 w-5 animate-pulse" /> Loading activity…
            </div>
          ) : error && !items.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
              <p className="max-w-md text-sm">{error}</p>
              <Button size="sm" variant="outline" onClick={() => load()}>Retry</Button>
            </div>
          ) : !items.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <History className="h-10 w-10 opacity-20" />
              <p>No activity in this range.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    {["When", "Staff", "Action", "Lead"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((a) => (
                    <tr key={a.id} className="hover:bg-muted/20">
                      <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                        {formatIST(a.createdAt, { dateStyle: "short", timeStyle: "short" })}
                      </td>
                      <td className="px-3 py-2.5 text-xs font-medium">{a.actorName}</td>
                      <td className="px-3 py-2.5 text-xs">{a.actionLabel}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{a.guestName ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && items.length > 0 && (
            <div className="border-t border-border px-3 py-2 text-center text-xs text-destructive">
              {error}
            </div>
          )}

          {nextCursor && (
            <div className="border-t border-border p-3 text-center">
              <Button size="sm" variant="ghost" onClick={() => load(nextCursor)} disabled={loading}>
                {loading ? "Loading…" : "Load older"}
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
