"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, X, Phone, AlarmClock, CalendarClock, CheckCircle2, ChevronDown, UserPlus, Search, MessageSquare, Trash2 } from "lucide-react";
import { Card, Badge, Select, Input } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";
import { STAGES, stageLabel } from "@/lib/kanban";
import { TagFilterBar } from "@/components/leads/tag-filter-bar";
import type { TagMatch } from "@/lib/tag-match";
import { formatTag, sortTags } from "@/lib/lead-tags";
import type { EnquiryStage } from "@prisma/client";

/** Mirrors the leads board's own source filter, minus its "" placeholder. */
const SOURCE_OPTIONS = [
  ["website_form", "Website"],
  ["whatsapp", "WhatsApp"],
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["referral", "Referral"],
  ["walk_in", "Walk-in"],
  ["phone", "Phone"],
  ["google_sheets", "Google Sheets"],
] as const;

interface AssignableUser {
  id: string;
  name: string;
  role: string | null;
}

interface TaskDTO {
  id: string;
  title: string;
  status: string;
  kind: string;
  approved: boolean | null;
  dueAt: string | null;
  overdue: boolean;
  enquiryId: string;
  guestName: string;
  guestPhone: string;
  stage: EnquiryStage;
  /** The lead's tags (merged system + custom), for the chips and the filter. */
  tags: string[];
  /** False when this task belongs to someone else but sits on a lead you own. */
  mine: boolean;
  assignedToName: string | null;
  /** Set only when someone other than the assignee asked for the task. */
  createdByName: string | null;
  /** Most recent remark on the lead — context for the call, trimmed server-side. */
  lastRemark: { body: string; authorName: string | null; createdAt: string } | null;
}

export function TasksList({
  canSeeAll,
  canRemoveDoctorTasks = false,
}: {
  canSeeAll: boolean;
  /** Admin (leads.delete). Doctor reviews are normally resolved by the
   *  doctor's decision on the lead; this only clears one raised in error. */
  canRemoveDoctorTasks?: boolean;
}) {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [completed, setCompleted] = useState<TaskDTO[]>([]);
  const [scope, setScope] = useState<"me" | "all">("me");
  // Only meaningful when scope === "all" — "" means every staff member.
  const [person, setPerson] = useState("");
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  // Lead-shaped filters: a follow-up is really "work on that lead", so these
  // describe the lead rather than the task.
  const [stage, setStage] = useState("");
  const [source, setSource] = useState("");
  const [q, setQ] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<TagMatch>("any");
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  // ?task=<id> from a "Task created" entry in a lead's activity timeline.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);
  // ?lead=<id> from the task chip on a lead card — this list, narrowed to
  // that one lead.
  const [leadId, setLeadId] = useState<string | null>(null);
  const router = useRouter();
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  // Read off window.location rather than useSearchParams() so this page
  // doesn't need a Suspense boundary — same reasoning as GuestSearch's ?q=.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("task");
    const lead = sp.get("lead");
    if (!id && !lead) return;
    if (id) setFocusId(id);
    if (lead) setLeadId(lead);
    // Tasks now belong to the LEAD OWNER, not whoever created them — so an
    // Admin/Manager clicking "Task created" in a lead's Activity tab is
    // almost always looking at someone else's task. Defaulting to "My
    // follow-ups" would land on "isn't in this list" for exactly the people
    // who came here to see it. Jump straight to All staff (Everyone) so the
    // deep link finds it in one hop, same as the notification bell already does.
    if (canSeeAll) setScope("all");
    // Strip it immediately: the highlight is a one-shot, and a refresh or a
    // later Back shouldn't re-trigger the scroll.
    router.replace("/tasks", { scroll: false });
  }, [router, canSeeAll]);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    Overdue: true,
    Upcoming: true,
    Completed: true,
  });

  useEffect(() => {
    api
      .get<string[]>("/api/tasks/tags")
      .then((t) => setAvailableTags(sortTags(t)))
      .catch(() => {});
  }, []);

  // Per-person filter options, for the same audience as reports.allStaff.
  useEffect(() => {
    if (!canSeeAll) return;
    api
      .get<AssignableUser[]>("/api/enquiries/assignable-users")
      .then(setAssignableUsers)
      .catch(() => {});
  }, [canSeeAll]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // A deep-linked task may already be done, and the list normally fetches
      // open ones only — widen to "all" just for that case so the target can
      // actually be found, then split by status below.
      const params = new URLSearchParams({ scope, status: focusId ? "all" : "open" });
      if (leadId) params.set("enquiryId", leadId);
      if (scope === "all" && person) params.set("assignee", person);
      if (stage) params.set("stage", stage);
      if (source) params.set("source", source);
      if (activeTags.length) {
        params.set("tags", activeTags.join(","));
        params.set("tagMatch", tagMatch);
      }
      if (q.trim().length >= 2) params.set("q", q.trim());
      const all = await api.get<TaskDTO[]>(`/api/tasks?${params}`);
      setTasks(all.filter((t) => t.status !== "done" && t.status !== "cancelled"));
      setCompleted(focusId ? all.filter((t) => t.status === "done" || t.status === "cancelled") : []);
      if (focusId) setFocusMissing(!all.some((t) => t.id === focusId));
    } finally {
      setLoading(false);
    }
  }, [scope, person, stage, source, activeTags, tagMatch, q, focusId, leadId]);

  useEffect(() => {
    // Debounced only for the search box; the selects settle immediately.
    clearTimeout(debounce.current);
    debounce.current = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(debounce.current);
  }, [load, q]);

  // Scroll the deep-linked task into view once it's rendered, and leave a
  // ring on it so it's obvious which of a long list was meant.
  useEffect(() => {
    if (!focusId || loading) return;
    const el = document.getElementById(`task-${focusId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, loading, tasks, completed]);

  async function complete(id: string) {
    const task = tasks.find((t) => t.id === id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (task) setCompleted((prev) => [{ ...task, status: "done" }, ...prev]);
    await api.patch(`/api/tasks/${id}`, { status: "done" }).catch(load);
  }

  async function removeDoctorTask(id: string) {
    const task = tasks.find((t) => t.id === id);
    if (
      !window.confirm(
        `Delete "${task?.title ?? "this doctor review"}"?\n\n` +
          "This cannot be undone. The lead keeps its consultation stage and " +
          "its history — only this task goes. Use it for a review raised in " +
          "error, not to skip one.",
      )
    ) {
      return;
    }
    setTasks((prev) => prev.filter((t) => t.id !== id));
    // A real delete, not a cancel — a cancelled review sits in the completed
    // list looking like a decision somebody made. The API still writes a
    // task_deleted entry to the lead's timeline, so the removal is on record
    // even though the task itself is gone.
    await api.delete(`/api/tasks/${id}`).catch(load);
  }

  async function decide(id: string, approved: boolean) {
    const task = tasks.find((t) => t.id === id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (task) setCompleted((prev) => [{ ...task, status: "done", approved }, ...prev]);
    await api.patch(`/api/tasks/${id}/decision`, { approved }).catch(load);
  }

  function toggleSection(name: string) {
    setOpenSections((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  // A Payment Pending chase sorts above everything else in its section and
  // stays there until the lead leaves the stage — a lead waiting on money is
  // the thing you want at eye level when you open this page.
  const pinFirst = (list: TaskDTO[]) => [
    ...list.filter((t) => t.kind === "payment_pending"),
    ...list.filter((t) => t.kind !== "payment_pending"),
  ];
  // Named from the rows themselves — every task in a ?lead= list is on the
  // same lead, so the first one carries the name.
  const leadName = leadId ? (tasks[0]?.guestName ?? completed[0]?.guestName ?? null) : null;
  const overdue = pinFirst(tasks.filter((t) => t.overdue));
  const upcoming = pinFirst(tasks.filter((t) => !t.overdue));
  const hasAny = overdue.length > 0 || upcoming.length > 0 || completed.length > 0;

  return (
    <div className="space-y-5 p-4 md:p-6">
      {canSeeAll && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border bg-secondary p-0.5 w-fit">
            {(["me", "all"] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                  setScope(s);
                  if (s === "me") setPerson("");
                }}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium",
                  scope === s ? "bg-background shadow-sm" : "text-muted-foreground",
                )}
              >
                {s === "me" ? "My follow-ups" : "All staff"}
              </button>
            ))}
          </div>
          {scope === "all" && assignableUsers.length > 0 && (
            <Select
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              className="w-44"
            >
              <option value="">Everyone</option>
              {assignableUsers.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </Select>
          )}
        </div>
      )}

      {/* Lead-shaped filters — a follow-up is work on a lead, so these narrow
          by the lead's column and where it came from, matching how the board
          is filtered. Available to everyone, not just reports.allStaff. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search guest name or phone…"
            className="h-9 pl-8 text-sm"
          />
        </div>
        <Select value={stage} onChange={(e) => setStage(e.target.value)} className="w-44">
          <option value="">All columns</option>
          {STAGES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </Select>
        <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-40">
          <option value="">All sources</option>
          {SOURCE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>
        {leadId && (
          <button
            onClick={() => setLeadId(null)}
            title="Show every lead's tasks again"
            className="flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-800"
          >
            {leadName ? `Tasks for ${leadName}` : "One lead only"}
            <X className="h-3 w-3" />
          </button>
        )}
        {(stage || source || q || activeTags.length > 0) && (
          <button
            onClick={() => { setStage(""); setSource(""); setQ(""); setActiveTags([]); }}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {availableTags.length > 0 && (
        <div className="-mx-4 md:-mx-6">
          <TagFilterBar
            availableTags={availableTags}
            activeTags={activeTags}
            onToggle={(t) =>
              setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
            }
            onClear={() => setActiveTags([])}
            match={tagMatch}
            onMatchChange={setTagMatch}
          />
        </div>
      )}

      {focusMissing && (
        <Card className="border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-900">
          {/* canSeeAll already lands here in All-staff/Everyone scope (see the
              ?task= effect above), so a miss there isn't a scope problem — most
              likely the task was completed/cancelled or the lead was deleted.
              A non-canSeeAll rep has no "All staff" to switch to, so their
              message stays about ownership rather than suggesting a toggle
              that isn't on their screen. */}
          {canSeeAll
            ? "That task isn't in this list — it may have been completed, cancelled, or the lead was deleted."
            : "That task isn't in this list — it may belong to another staff member."}
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : !hasAny ? (
        <Card className="py-12 text-center text-sm text-muted-foreground">
          {leadId
            ? "No open follow-ups on this lead — they may have been completed, or belong to another staff member."
            : "No open follow-ups. Nice — inbox zero. 🌿"}
        </Card>
      ) : (
        <div className="space-y-4">
          {overdue.length > 0 && (
            <Section
              title="Overdue"
              icon={AlarmClock}
              tone="rose"
              tasks={overdue}
              open={openSections["Overdue"] ?? true}
              onToggle={() => toggleSection("Overdue")}
              onComplete={complete}
              onDecide={decide}
              onRemoveDoctorTask={canRemoveDoctorTasks ? removeDoctorTask : undefined}
              focusId={focusId}
            />
          )}
          {upcoming.length > 0 && (
            <Section
              title="Upcoming"
              icon={CalendarClock}
              tone="brand"
              tasks={upcoming}
              open={openSections["Upcoming"] ?? true}
              onToggle={() => toggleSection("Upcoming")}
              onComplete={complete}
              onDecide={decide}
              onRemoveDoctorTask={canRemoveDoctorTasks ? removeDoctorTask : undefined}
              focusId={focusId}
            />
          )}
          {completed.length > 0 && (
            <Section
              title="Completed"
              icon={CheckCircle2}
              tone="green"
              tasks={completed}
              open={openSections["Completed"] ?? true}
              onToggle={() => toggleSection("Completed")}
              onComplete={() => {}}
              onDecide={() => {}}
              focusId={focusId}
              dimmed
            />
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  tone,
  tasks,
  open,
  onToggle,
  onComplete,
  onDecide,
  onRemoveDoctorTask,
  focusId = null,
  dimmed = false,
}: {
  title: string;
  icon: typeof AlarmClock;
  tone: "rose" | "brand" | "green";
  tasks: TaskDTO[];
  open: boolean;
  onToggle: () => void;
  onComplete: (id: string) => void;
  onDecide: (id: string, approved: boolean) => void;
  /** Admins only — undefined for everyone else, which hides the control. */
  onRemoveDoctorTask?: (id: string) => void;
  /** Task deep-linked from a lead's activity timeline — ringed and scrolled to. */
  focusId?: string | null;
  dimmed?: boolean;
}) {
  const iconColor =
    tone === "rose"
      ? "text-rose-500"
      : tone === "green"
        ? "text-emerald-500"
        : "text-brand-600";
  const router = useRouter();

  return (
    <div>
      <button
        onClick={onToggle}
        className="mb-2 flex w-full items-center gap-1.5 text-sm font-semibold text-foreground hover:opacity-80"
      >
        <Icon className={cn("h-4 w-4", iconColor)} />
        {title}
        <span className="font-normal text-muted-foreground">({tasks.length})</span>
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200",
            !open && "-rotate-90",
          )}
        />
      </button>

      {open && (
        <div className="space-y-2">
          {tasks.map((t) => (
            <Card
              key={t.id}
              id={`task-${t.id}`}
              onClick={() => router.push(`/leads?lead=${t.enquiryId}`)}
              title="Open this lead"
              className={cn(
                "flex cursor-pointer items-center gap-3 p-3 transition-opacity hover:bg-secondary/40",
                t.overdue && !dimmed && "border-rose-200 bg-rose-50/40",
                dimmed && "opacity-55",
                // Arrived here from a lead's timeline — say which one was meant.
                t.id === focusId && "border-brand-400 ring-2 ring-brand-300 ring-offset-1",
              )}
            >
              {t.kind === "deletion_approval" ? (
                dimmed ? (
                  <div
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
                      t.approved
                        ? "border-emerald-400 bg-emerald-50 text-emerald-500"
                        : "border-rose-400 bg-rose-50 text-rose-500",
                    )}
                    title={t.approved ? "Approved" : "Denied"}
                  >
                    {t.approved ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                  </div>
                ) : (
                  <div className="flex shrink-0 gap-1.5">
                    <button
                      onClick={(e) => { e.stopPropagation(); onDecide(t.id, true); }}
                      title="Approve — move this lead to Lost/Dead"
                      className="flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                    >
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDecide(t.id, false); }}
                      title="Deny — lead stays where it is"
                      className="flex h-7 items-center gap-1 rounded-md border border-rose-300 bg-rose-50 px-2 text-xs font-medium text-rose-700 hover:bg-rose-100"
                    >
                      <X className="h-3.5 w-3.5" /> Deny
                    </button>
                  </div>
                )
              ) : t.kind === "payment_pending" ? (
                dimmed ? (
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-400 bg-emerald-50 text-emerald-500"
                    title="Payment collected — lead moved on"
                  >
                    <Check className="h-4 w-4" />
                  </div>
                ) : (
                  <div
                    className="flex h-7 shrink-0 items-center rounded-md border border-amber-300 bg-amber-100 px-2 text-[11px] font-medium text-amber-800"
                    title="Closes by itself when the lead leaves Payment Pending"
                  >
                    Payment pending
                  </div>
                )
              ) : t.kind === "doctor_review" ? (
                dimmed ? (
                  // A cancelled review is not a resolved one. Both used to
                  // render the same green tick, which read as "the doctor
                  // decided" for a task that was removed without a decision.
                  t.status === "cancelled" ? (
                    <div
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground"
                      title="Removed without a doctor's decision"
                    >
                      <X className="h-4 w-4" />
                    </div>
                  ) : (
                    <div
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-400 bg-emerald-50 text-emerald-500"
                      title="Resolved"
                    >
                      <Check className="h-4 w-4" />
                    </div>
                  )
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <div
                      className="flex h-7 items-center rounded-md border border-indigo-300 bg-indigo-50 px-2 text-[11px] font-medium text-indigo-700"
                      title="Resolved from the lead's consultation decision, not here"
                    >
                      Awaiting doctor
                    </div>
                    {/* Admin escape hatch for a review raised in error — a
                        duplicate, or a lead that has since gone elsewhere.
                        Absent for everyone else, since the normal way to
                        clear one of these is the doctor's own decision. */}
                    {onRemoveDoctorTask && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onRemoveDoctorTask(t.id); }}
                        title="Delete this doctor review (admin only) — permanent; the lead is untouched"
                        aria-label="Delete this doctor review"
                        className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); onComplete(t.id); }}
                  title={dimmed ? "Completed" : "Mark done"}
                  disabled={dimmed}
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors",
                    dimmed
                      ? "cursor-default border-emerald-400 bg-emerald-50 text-emerald-500"
                      : "border-border text-muted-foreground hover:border-brand-500 hover:bg-brand-500 hover:text-white",
                  )}
                >
                  <Check className="h-4 w-4" />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "truncate text-sm font-medium text-foreground",
                    dimmed && "line-through",
                  )}
                >
                  {t.title}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Phone className="h-3 w-3" />
                    {t.guestName} · {t.guestPhone}
                  </span>
                  <Badge className="bg-secondary text-secondary-foreground">
                    {stageLabel(t.stage)}
                  </Badge>
                  {sortTags(t.tags ?? []).slice(0, 3).map((tag) => {
                    const f = formatTag(tag);
                    return (
                      <Badge key={tag} className={f.className}>{f.label}</Badge>
                    );
                  })}
                  {/* Shown only for someone else's task — you now see tasks on
                      leads you own whoever created them, and without this
                      there's no way to tell those apart from your own. */}
                  {!t.mine && (
                    <Badge className="bg-amber-100 text-amber-800">
                      for {t.assignedToName ?? "unassigned"}
                    </Badge>
                  )}
                  {/* A follow-up lands in the LEAD OWNER's queue whoever typed
                      it, so this is the only thing saying who asked. */}
                  {t.createdByName && (
                    <span className="inline-flex items-center gap-1">
                      <UserPlus className="h-3 w-3" />
                      added by {t.createdByName}
                    </span>
                  )}
                </div>
                {/* The lead's latest remark — the thing you'd otherwise open
                    the lead to read before picking up the phone. One line;
                    the full text is on the lead. */}
                {t.lastRemark && (
                  <div className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <MessageSquare className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate italic" title={t.lastRemark.body}>
                      &ldquo;{t.lastRemark.body}&rdquo;
                    </span>
                    <span className="shrink-0 not-italic">
                      {t.lastRemark.authorName ? `— ${t.lastRemark.authorName} · ` : ""}
                      {formatIST(t.lastRemark.createdAt, {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                )}
              </div>
              {t.dueAt && (
                <div
                  className={cn(
                    "shrink-0 text-xs",
                    t.overdue && !dimmed ? "text-rose-600" : "text-muted-foreground",
                  )}
                >
                  {formatIST(t.dueAt, {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
