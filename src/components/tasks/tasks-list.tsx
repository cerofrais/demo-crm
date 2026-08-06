"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, X, Phone, AlarmClock, CalendarClock, CheckCircle2, ChevronDown } from "lucide-react";
import { Card, Badge, Select } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";
import { stageLabel } from "@/lib/kanban";
import type { EnquiryStage } from "@prisma/client";

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
}

export function TasksList({ canSeeAll }: { canSeeAll: boolean }) {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [completed, setCompleted] = useState<TaskDTO[]>([]);
  const [scope, setScope] = useState<"me" | "all">("me");
  // Only meaningful when scope === "all" — "" means every staff member.
  const [person, setPerson] = useState("");
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    Overdue: true,
    Upcoming: true,
    Completed: true,
  });

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
      const params = new URLSearchParams({ scope, status: "open" });
      if (scope === "all" && person) params.set("assignee", person);
      setTasks(await api.get<TaskDTO[]>(`/api/tasks?${params}`));
      setCompleted([]);
    } finally {
      setLoading(false);
    }
  }, [scope, person]);

  useEffect(() => {
    load();
  }, [load]);

  async function complete(id: string) {
    const task = tasks.find((t) => t.id === id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (task) setCompleted((prev) => [{ ...task, status: "done" }, ...prev]);
    await api.patch(`/api/tasks/${id}`, { status: "done" }).catch(load);
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

  const overdue = tasks.filter((t) => t.overdue);
  const upcoming = tasks.filter((t) => !t.overdue);
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

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : !hasAny ? (
        <Card className="py-12 text-center text-sm text-muted-foreground">
          No open follow-ups. Nice — inbox zero. 🌿
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
              onClick={() => router.push(`/leads?lead=${t.enquiryId}`)}
              title="Open this lead"
              className={cn(
                "flex cursor-pointer items-center gap-3 p-3 transition-opacity hover:bg-secondary/40",
                t.overdue && !dimmed && "border-rose-200 bg-rose-50/40",
                dimmed && "opacity-55",
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
              ) : t.kind === "doctor_review" ? (
                dimmed ? (
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-400 bg-emerald-50 text-emerald-500"
                    title="Resolved"
                  >
                    <Check className="h-4 w-4" />
                  </div>
                ) : (
                  <div
                    className="flex h-7 shrink-0 items-center rounded-md border border-indigo-300 bg-indigo-50 px-2 text-[11px] font-medium text-indigo-700"
                    title="Resolved from the lead's consultation decision, not here"
                  >
                    Awaiting doctor
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
                </div>
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
