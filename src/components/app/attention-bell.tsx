"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Loader2, Mail, MessageCircle, ChevronRight, AlarmClock } from "lucide-react";
import { api } from "@/lib/client";
import { formatIST } from "@/lib/utils";
import { stageLabel } from "@/lib/kanban";
import type { EnquiryStage } from "@prisma/client";

/** Matches the leads board's own auto-refresh, so the two never disagree for long. */
const POLL_SEC = Number(process.env.NEXT_PUBLIC_LEADS_AUTOREFRESH_INTERVAL_SEC ?? 30);

interface AttentionItem {
  enquiryId: string;
  guestName: string;
  stage: EnquiryStage;
  lastActivityAt: string;
  message: { channel: string; preview: string; subject: string | null; createdAt: string } | null;
  task: { title: string; dueAt: string | null } | null;
}

/**
 * Notification badge + dropdown: which leads are waiting on this user, and
 * what came in on each.
 *
 * The count comes from the server scoped to what this user can actually see,
 * so a Sales rep's badge counts their own leads and a Manager's counts the
 * whole board. Roles with no leads access render nothing at all: the request
 * 403s and the component hides itself, which is also what keeps it safe to
 * mount without the caller knowing anything about roles.
 *
 * The list is fetched only when the dropdown is opened — the badge polls on a
 * timer and only needs a number, so pulling message bodies every 30 seconds to
 * render a digit would be waste.
 */
export function AttentionBell() {
  const [count, setCount] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [limit, setLimit] = useState(15);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ count: number }>("/api/enquiries/attention-count");
      setCount(res.count);
    } catch {
      // 403 for a role without leads access, or a transient network blip.
      // Either way the badge stops showing rather than reporting a number it
      // can't stand behind.
      setHidden(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (POLL_SEC <= 0) return;
    const id = setInterval(() => void refresh(), POLL_SEC * 1000);
    // Coming back to the tab should be current immediately, not up to a full
    // interval stale — this is the moment someone actually looks at it.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const fetchList = useCallback((n: number) => {
    setLoadingList(true);
    api
      .get<{ count: number; items: AttentionItem[] }>(`/api/enquiries/attention-count?list=1&limit=${n}`)
      .then((r) => {
        setItems(r.items);
        setCount(r.count);
      })
      .catch(() => setItems([]))
      .finally(() => setLoadingList(false));
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    // Always refetch on open, and back at the first page: the flags clear as
    // leads are read, so a cached list would offer things no longer waiting.
    setLimit(15);
    fetchList(15);
  }

  function showMore() {
    const next = limit + 15;
    setLimit(next);
    fetchList(next);
  }

  /** Open the lead on the channel the message actually arrived on. */
  function openLead(item: AttentionItem) {
    const tab =
      item.message?.channel === "whatsapp"
        ? "whatsapp"
        : item.message?.channel === "email"
          ? "conversation"
          : undefined;
    setOpen(false);
    router.push(`/leads?lead=${item.enquiryId}${tab ? `&tab=${tab}` : ""}`);
  }

  if (hidden || count === null) return null;

  const label =
    count === 0
      ? "Nothing waiting on you"
      : `${count} lead${count === 1 ? "" : "s"} waiting on you`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        title={label}
        aria-label={label}
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <Bell className="h-5 w-5" />
        {count > 0 && (
          <>
            {/* Same amber as the dot on the card, so the badge and the
                per-card dot read as one signal. */}
            <span className="absolute -right-0.5 -top-0.5 flex min-w-[1.05rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-4 text-white">
              {count > 99 ? "99+" : count}
            </span>
            <span className="absolute -right-0.5 -top-0.5 h-[1.05rem] w-[1.05rem] animate-ping rounded-full bg-amber-400 opacity-60" />
          </>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[22rem] rounded-md border border-border bg-popover shadow-lg">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
            {label}
          </div>

          <div className="max-h-[24rem] overflow-y-auto">
            {loadingList && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            )}
            {!loadingList && items?.length === 0 && (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                Nothing needs your attention right now. 🌿
              </p>
            )}
            {!loadingList &&
              items?.map((item) => (
                <button
                  key={item.enquiryId}
                  type="button"
                  onClick={() => openLead(item)}
                  className="flex w-full items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-0 hover:bg-secondary"
                >
                  <span className="mt-0.5 shrink-0">
                    {item.message?.channel === "whatsapp" ? (
                      <MessageCircle className="h-4 w-4 text-emerald-600" />
                    ) : item.message?.channel === "email" ? (
                      <Mail className="h-4 w-4 text-sky-600" />
                    ) : item.task ? (
                      <AlarmClock className="h-4 w-4 text-amber-500" />
                    ) : (
                      <Bell className="h-4 w-4 text-amber-500" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {item.guestName}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {formatIST(item.message?.createdAt ?? item.lastActivityAt, {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {item.message
                        ? item.message.subject
                          ? `${item.message.subject} — ${item.message.preview}`
                          : item.message.preview
                        : (item.task?.title ?? "Needs a look")}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {stageLabel(item.stage)}
                    </span>
                  </span>
                  <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              ))}
          </div>

          <div className="border-t border-border">
            {/* The list is capped; without this the badge and the list would
                silently disagree once more than a page is waiting. */}
            {!loadingList && items && count > items.length && (
              <button
                type="button"
                onClick={showMore}
                className="w-full px-3 py-2 text-center text-xs font-medium text-brand-700 hover:bg-secondary"
              >
                Show more ({count - items.length} more)
              </button>
            )}
            <button
              type="button"
              onClick={() => { setOpen(false); router.push("/tasks"); }}
              className="flex w-full items-center justify-center gap-1 border-t border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-secondary"
            >
              Go to Tasks <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
