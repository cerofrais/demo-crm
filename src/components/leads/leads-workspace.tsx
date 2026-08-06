"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  LayoutGrid,
  List,
  Plus,
  Search,
  Download,
  RefreshCw,
  SlidersHorizontal,
  PauseCircle,
  PlayCircle,
} from "lucide-react";
import { Button, Input, Select, Sheet } from "@/components/ui";
import { KanbanBoard } from "./kanban-board";
import { KanbanMobile } from "./kanban-mobile";
import { LeadsTable } from "./leads-table";
import { LeadDrawer } from "./lead-drawer";
import { NewLeadDialog } from "./new-lead-dialog";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { sortTags } from "@/lib/lead-tags";
import { TagFilterBar } from "./tag-filter-bar";
import type { EnquiryDTO } from "@/lib/types";
import type { EnquiryStage } from "@prisma/client";
import type { StageDef } from "@/lib/kanban";

// Client-exposed at build time by Next.js (NEXT_PUBLIC_ prefix required — do
// NOT read this through src/lib/env.ts, which is server-only and would pull
// server-only deps into the client bundle). 0 or unset/invalid -> disabled.
const AUTOREFRESH_INTERVAL_SEC = Number(process.env.NEXT_PUBLIC_LEADS_AUTOREFRESH_INTERVAL_SEC ?? 30);

const SOURCES = [
  ["", "All sources"],
  ["website_form", "Website"],
  ["whatsapp", "WhatsApp"],
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["referral", "Referral"],
  ["walk_in", "Walk-in"],
  ["phone", "Phone"],
  ["google_sheets", "Google Sheets"],
] as const;

export function LeadsWorkspace({
  initial,
  canManage,
  canWorkLeads,
  canDelete = false,
  canCreate = true,
  canDoctorDecide = false,
  isAdmin = false,
  visibleStages,
  currentSub,
}: {
  initial: EnquiryDTO[];
  canManage: boolean;
  /** Can mutate a lead at all (edit fields, remark, task, drag stage) — the
   *  broader "leads.manage OR ownOnly OR consultationOnly" check. False for
   *  a read-only Viewer, who still has canManage=false but also can't do
   *  anything ownOnly/consultationOnly roles could. */
  canWorkLeads: boolean;
  canDelete?: boolean;
  /** False hides "New lead" — e.g. Doctor, who can view but not create. */
  canCreate?: boolean;
  /** Shows the Accept/Reject/Needs-phone-consult banner — Doctor only. */
  canDoctorDecide?: boolean;
  /** The Staff column/stage is Admin-only, including for Manager — gates the
   *  drawer's Stage dropdown from offering it as a target. */
  isAdmin?: boolean;
  /** Kanban columns to render — full pipeline by default, or a role-scoped
   *  subset (e.g. Doctor sees only Doctor Consultation). */
  visibleStages?: StageDef[];
  currentSub: string;
}) {
  const [enquiries, setEnquiries] = useState<EnquiryDTO[]>(initial);
  const [view, setView] = useState<"pipeline" | "list">("pipeline");
  const [q, setQ] = useState("");
  const [source, setSource] = useState("");
  const [gender, setGender] = useState("");
  // "all" | "me" | "unassigned" are sentinels; any other value is a specific
  // staff member's Keycloak sub (Admin/Manager only — see assignableUsers).
  const [assignee, setAssignee] = useState<string>("all");
  const [assignableUsers, setAssignableUsers] = useState<{ id: string; name: string; role: string | null }[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Time only ever applies alongside its date — a bare time isn't a valid
  // absolute filter on its own, so these are ignored unless dateFrom/dateTo
  // is also set (the inputs are disabled in that case too, not just ignored).
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [selected, setSelected] = useState<EnquiryDTO | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(AUTOREFRESH_INTERVAL_SEC > 0);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  const { isPhone, mounted } = useBreakpoint();
  const router = useRouter();
  const searchParams = useSearchParams();

  const toggleTag = useCallback((tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }, []);

  // Per-person filter options for Admin/Manager — same audience as leads.manage.
  useEffect(() => {
    if (!canManage) return;
    api
      .get<{ id: string; name: string; role: string | null }[]>("/api/enquiries/assignable-users")
      .then((users) => setAssignableUsers(users.filter((u) => u.id !== currentSub)))
      .catch(() => {});
  }, [canManage, currentSub]);

  // Deep-link support — a task card in Tasks & Reminders links here with
  // ?lead=<enquiryId> to jump straight to that lead's drawer. Checks the
  // already-loaded list first (the common case); falls back to fetching it
  // directly for a lead outside the current filter/page. The param is
  // stripped right after so a later refresh/back doesn't reopen the drawer.
  useEffect(() => {
    const leadId = searchParams.get("lead");
    if (!leadId) return;
    const inList = enquiries.find((e) => e.id === leadId);
    if (inList) {
      setSelected(inList);
    } else {
      api.get<EnquiryDTO>(`/api/enquiries/${leadId}`).then(setSelected).catch(() => {});
    }
    router.replace("/leads", { scroll: false });
    // Deliberately one-shot on the param itself, not on `enquiries` (which
    // changes on every poll) or `router` (stable but would still be noise).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const refetch = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (source) params.set("source", source);
    if (gender) params.set("gender", gender);
    if (assignee === "me") params.set("assignee", "me");
    else if (assignee !== "all" && assignee !== "unassigned") params.set("assignee", assignee);
    if (dateFrom) params.set("from", dateFrom + (timeFrom ? `T${timeFrom}` : ""));
    if (dateTo) params.set("to", dateTo + (timeTo ? `T${timeTo}` : ""));
    try {
      const data = await api.get<EnquiryDTO[]>(`/api/enquiries?${params}`);
      setEnquiries(
        assignee === "unassigned"
          ? data.filter((e) => e.assignedToSub === null)
          : data,
      );
      setLoadError(null);
    } catch (e) {
      // Every caller is fire-and-forget (debounced load, filter changes, the
      // toolbar buttons), so rethrowing would just be an unhandled rejection and
      // the user would stare at an empty board. Surface it instead; the silent
      // poll stays quiet so an offline window doesn't nag every interval tick.
      if (!opts.silent) {
        setLoadError(e instanceof Error ? e.message : "Failed to load leads");
      }
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, [q, source, gender, assignee, dateFrom, dateTo, timeFrom, timeTo]);

  // Re-query on filter change (debounced for the search box).
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => refetch(), 250);
    return () => clearTimeout(debounce.current);
  }, [refetch]);

  // Poll for new/changed tickets. Paused while a lead's drawer is open — the
  // poll only ever touches `enquiries`, never `selected`, so an actively-open
  // ticket's fields can't change under the user while they're working on it;
  // skipping the fetch outright while `selected` is set is the explicit,
  // visible half of that guarantee (also saves a request nobody needs yet).
  useEffect(() => {
    if (!autoRefresh || AUTOREFRESH_INTERVAL_SEC <= 0 || selected) return;
    const id = setInterval(() => refetch({ silent: true }), AUTOREFRESH_INTERVAL_SEC * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, selected, refetch]);

  const onMove = useCallback(
    async (id: string, stage: EnquiryStage) => {
      // A read-only Viewer has no drag handle rendered (see canDrag below),
      // but guard the handler too in case anything else ever calls it.
      if (!canWorkLeads) return;
      // Optimistic update; reconcile with the server's response (handles
      // drag-to-assign so the owner shows immediately).
      setEnquiries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, stage } : e)),
      );
      try {
        const updated = await api.patch<EnquiryDTO>(
          `/api/enquiries/${id}/stage`,
          { stage },
        );
        setEnquiries((prev) => prev.map((e) => (e.id === id ? updated : e)));
      } catch {
        refetch(); // revert on failure
      }
    },
    [refetch, canWorkLeads],
  );

  const replace = useCallback((e: EnquiryDTO) => {
    setEnquiries((prev) => prev.map((x) => (x.id === e.id ? e : x)));
    setSelected((s) => (s?.id === e.id ? e : s));
  }, []);

  const handleDeleted = useCallback((id: string) => {
    setEnquiries((prev) => prev.filter((e) => e.id !== id));
    setSelected((s) => (s?.id === id ? null : s));
  }, []);

  // Distinct tags currently on the board → the clickable filter bar.
  const availableTags = useMemo(
    () => sortTags(Array.from(new Set(enquiries.flatMap((e) => e.tags)))),
    [enquiries],
  );

  // Client-side tag filter (AND): a lead must carry every active tag.
  const visible = useMemo(
    () =>
      activeTags.length
        ? enquiries.filter((e) => activeTags.every((t) => e.tags.includes(t)))
        : enquiries,
    [enquiries, activeTags],
  );

  const counts = useMemo(
    () => ({
      total: visible.length,
      mine: visible.filter((e) => e.assignedToSub === currentSub).length,
    }),
    [visible, currentSub],
  );

  function exportCsv() {
    const headers = ["Phone", "Name", "Email", "City", "Source", "Stage", "Owner"];
    const rows = enquiries.map((e) => [
      e.guest.phone,
      e.guest.fullName,
      e.guest.email ?? "",
      e.guest.city ?? "",
      e.source,
      e.stage,
      e.assignedToName ?? "",
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tre-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="border-b border-border bg-background px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold">Leads</h1>
            <p className="text-xs text-muted-foreground">
              {counts.total} shown · {counts.mine} assigned to you
            </p>
          </div>

          {/* View toggle */}
          <div className="flex rounded-lg border border-border bg-secondary p-0.5">
            <button
              onClick={() => setView("pipeline")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium",
                view === "pipeline" ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
            >
              <LayoutGrid className="h-4 w-4" /> <span className="hidden sm:inline">Pipeline</span>
            </button>
            <button
              onClick={() => setView("list")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium",
                view === "list" ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
            >
              <List className="h-4 w-4" /> <span className="hidden sm:inline">List</span>
            </button>
          </div>

          {canCreate && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" /> <span className="hidden sm:inline">New lead</span>
            </Button>
          )}
        </div>

        {/* Search — its own row so it never has to shrink to share space
            with the filter controls. */}
        <div className="mt-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, phone, email…"
              className="w-full pl-8"
            />
          </div>

          {/* Phone: open filters in a bottom sheet */}
          <Button
            variant="outline"
            className="shrink-0 md:hidden"
            onClick={() => setShowFilters(true)}
          >
            <SlidersHorizontal className="h-4 w-4" /> Filters
          </Button>
        </div>

        {/* md+: filters, own row below search — wraps instead of shrinking
            when there isn't room for all of them side by side. */}
        <div className="mt-2 hidden flex-wrap items-center gap-2 md:flex">
          <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-36">
            {SOURCES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Select value={gender} onChange={(e) => setGender(e.target.value)} className="w-32">
            <option value="">All genders</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </Select>
          <Select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="w-36"
          >
            <option value="all">All owners</option>
            <option value="me">My leads</option>
            <option value="unassigned">Unassigned</option>
            {assignableUsers.length > 0 && (
              <optgroup label="Filter by person">
                {assignableUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </optgroup>
            )}
          </Select>
          <div className="flex flex-nowrap items-center gap-1">
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              title="Created from"
              aria-label="Created from"
              className="w-[9.5rem] shrink-0 px-2"
            />
            <Input
              type="time"
              value={timeFrom}
              onChange={(e) => setTimeFrom(e.target.value)}
              disabled={!dateFrom}
              title="Time from"
              aria-label="Time from"
              className="w-28 shrink-0 px-2"
            />
            <span className="shrink-0 text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              title="Created to"
              aria-label="Created to"
              className="w-[9.5rem] shrink-0 px-2"
            />
            <Input
              type="time"
              value={timeTo}
              onChange={(e) => setTimeTo(e.target.value)}
              disabled={!dateTo}
              title="Time to"
              aria-label="Time to"
              className="w-28 shrink-0 px-2"
            />
          </div>
          <Button variant="outline" size="icon" onClick={() => refetch()} title="Refresh">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          {AUTOREFRESH_INTERVAL_SEC > 0 && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => setAutoRefresh((v) => !v)}
              title={
                autoRefresh
                  ? `Auto-refresh on (every ${AUTOREFRESH_INTERVAL_SEC}s) — click to pause`
                  : "Auto-refresh paused — click to resume"
              }
            >
              {autoRefresh ? (
                <PauseCircle className="h-4 w-4 text-brand-600" />
              ) : (
                <PlayCircle className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          )}
          <Button variant="outline" size="icon" onClick={exportCsv} title="Export CSV">
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Phone filters sheet */}
      <Sheet
        open={showFilters}
        onClose={() => setShowFilters(false)}
        side="bottom"
        title="Filters"
      >
        <div className="space-y-3 p-4">
          <label className="block space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</span>
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Gender</span>
            <Select value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="">All genders</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
            </Select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Owner</span>
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="all">All owners</option>
              <option value="me">My leads</option>
              <option value="unassigned">Unassigned</option>
              {assignableUsers.length > 0 && (
                <optgroup label="Filter by person">
                  {assignableUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </optgroup>
              )}
            </Select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Created from</span>
            <div className="flex flex-nowrap items-center gap-1.5">
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="min-w-0 flex-1 px-2" />
              <Input
                type="time"
                value={timeFrom}
                onChange={(e) => setTimeFrom(e.target.value)}
                disabled={!dateFrom}
                className="w-28 shrink-0 px-2"
              />
            </div>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Created to</span>
            <div className="flex flex-nowrap items-center gap-1.5">
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="min-w-0 flex-1 px-2" />
              <Input
                type="time"
                value={timeTo}
                onChange={(e) => setTimeTo(e.target.value)}
                disabled={!dateTo}
                className="w-28 shrink-0 px-2"
              />
            </div>
          </label>
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={() => refetch()}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Refresh
            </Button>
            <Button variant="outline" className="flex-1" onClick={exportCsv}>
              <Download className="h-4 w-4" /> Export
            </Button>
          </div>
        </div>
      </Sheet>

      {/* Load failures (401 / offline / server error) — without this the board
          just sits empty with no explanation. */}
      {loadError && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-destructive/10 px-4 py-2 text-sm text-destructive md:px-6">
          <span>{loadError}</span>
          <button
            onClick={() => refetch()}
            className="font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}

      {/* Tag filter bar */}
      <TagFilterBar
        availableTags={availableTags}
        activeTags={activeTags}
        onToggle={toggleTag}
        onClear={() => setActiveTags([])}
      />

      {/* Board / table */}
      <div className="min-h-0 flex-1">
        {view === "pipeline" ? (
          mounted && isPhone ? (
            <KanbanMobile enquiries={visible} onMove={onMove} onSelect={setSelected} stages={visibleStages} canDrag={canWorkLeads} />
          ) : (
            <KanbanBoard enquiries={visible} onMove={onMove} onSelect={setSelected} stages={visibleStages} canDrag={canWorkLeads} />
          )
        ) : (
          <LeadsTable enquiries={visible} onSelect={setSelected} />
        )}
      </div>

      <LeadDrawer
        enquiry={selected}
        canManage={canManage}
        canWorkLeads={canWorkLeads}
        canDelete={canDelete}
        canDoctorDecide={canDoctorDecide}
        isAdmin={isAdmin}
        onClose={() => setSelected(null)}
        onUpdated={replace}
        onDeleted={handleDeleted}
      />
      {showNew && (
        <NewLeadDialog
          onClose={() => setShowNew(false)}
          onCreated={(e) => setEnquiries((prev) => [e, ...prev])}
        />
      )}
    </div>
  );
}
