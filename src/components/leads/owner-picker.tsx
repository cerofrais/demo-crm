"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Search, Check } from "lucide-react";
import { Input, Avatar } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { EnquiryDTO } from "@/lib/types";

interface AssignableUser {
  id: string;
  name: string;
  role: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  RECEPTION: "Reception",
  SALES: "Sales",
  DOCTOR: "Doctor",
  STAFF: "Staff",
};

/** Owner field for the lead drawer — read-only text for most roles, a
 * searchable reassign dropdown for Admin/Manager (canManage). */
export function OwnerPicker({
  enquiryId,
  assignedToSub,
  assignedToName,
  canManage,
  onUpdated,
}: {
  enquiryId: string;
  assignedToSub: string | null;
  assignedToName: string | null;
  canManage: boolean;
  onUpdated: (e: EnquiryDTO) => void;
}) {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<AssignableUser[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function openPicker() {
    if (!canManage) return;
    setOpen((o) => !o);
    if (users === null) {
      setLoading(true);
      setError(null);
      api
        .get<AssignableUser[]>("/api/enquiries/assignable-users")
        .then(setUsers)
        .catch(() => setError("Couldn't load staff list."))
        .finally(() => setLoading(false));
    }
  }

  async function assign(u: AssignableUser) {
    if (u.id === assignedToSub) { setOpen(false); return; }
    setAssigningId(u.id);
    try {
      const updated = await api.patch<EnquiryDTO>(`/api/enquiries/${enquiryId}`, {
        assignedToSub: u.id,
        assignedToName: u.name,
      });
      onUpdated(updated);
      setOpen(false);
      setQuery("");
    } finally {
      setAssigningId(null);
    }
  }

  const filtered = (users ?? []).filter((u) =>
    u.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  if (!canManage) {
    return (
      <div className="text-sm text-foreground">
        {assignedToName ?? "Unassigned (move a card to claim)"}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={openPicker}
        className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1.5 text-left text-sm shadow-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2 truncate">
          {assignedToName && <Avatar name={assignedToName} className="h-5 w-5 text-[10px]" />}
          <span className={cn(!assignedToName && "text-muted-foreground")}>
            {assignedToName ?? "Unassigned — click to assign"}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-full min-w-[16rem] rounded-md border border-border bg-popover shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search staff by name…"
              className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading staff…
              </div>
            )}
            {error && <p className="px-3 py-3 text-sm text-destructive">{error}</p>}
            {!loading && !error && filtered.length === 0 && (
              <p className="px-3 py-3 text-sm text-muted-foreground">No matching staff.</p>
            )}
            {!loading &&
              filtered.map((u) => {
                const isCurrent = u.id === assignedToSub;
                return (
                  <button
                    key={u.id}
                    type="button"
                    disabled={assigningId !== null}
                    onClick={() => assign(u)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-60",
                      isCurrent && "bg-brand-50",
                    )}
                  >
                    <Avatar name={u.name} className="h-6 w-6 text-[10px]" />
                    <span className="flex-1 truncate">
                      <span className="block truncate font-medium text-foreground">{u.name}</span>
                      {u.role && (
                        <span className="text-xs text-muted-foreground">{ROLE_LABEL[u.role] ?? u.role}</span>
                      )}
                    </span>
                    {assigningId === u.id ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : isCurrent ? (
                      <Check className="h-4 w-4 shrink-0 text-brand-600" />
                    ) : null}
                  </button>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
