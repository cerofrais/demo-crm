"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Check } from "lucide-react";
import { STAGES, type StageDef } from "@/lib/kanban";
import { ScrollableTabs, Sheet, type TabItem } from "@/components/ui";
import { LeadCard } from "./lead-card";
import { cn } from "@/lib/utils";
import type { EnquiryDTO } from "@/lib/types";
import type { EnquiryStage } from "@prisma/client";

/**
 * Phone Kanban: one stage at a time via swipeable stage tabs, with a single
 * scrolling column. Moving a lead uses a bottom-sheet stage picker instead of
 * drag-and-drop (which doesn't translate to a narrow, single-column view).
 * The multi-column board (kanban-board.tsx) is still used at md+.
 */
export function KanbanMobile({
  enquiries,
  onMove,
  onSelect,
  stages = STAGES,
  canDrag = true,
}: {
  enquiries: EnquiryDTO[];
  onMove: (id: string, stage: EnquiryStage) => void;
  onSelect: (e: EnquiryDTO) => void;
  /** Stage tabs to render — defaults to the full pipeline. */
  stages?: StageDef[];
  /** False hides the "Move" button — a read-only Viewer. */
  canDrag?: boolean;
}) {
  const [activeStage, setActiveStage] = useState<EnquiryStage>(stages[0].id);
  const [moveTarget, setMoveTarget] = useState<EnquiryDTO | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // Swipe left/right on the column to move between stages (thumb-friendly).
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;
    // Require a mostly-horizontal swipe so it doesn't fight vertical scroll.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const idx = stages.findIndex((s) => s.id === activeStage);
    if (dx < 0 && idx < stages.length - 1) setActiveStage(stages[idx + 1].id);
    else if (dx > 0 && idx > 0) setActiveStage(stages[idx - 1].id);
  }

  const grouped = useMemo(() => {
    const map = new Map<EnquiryStage, EnquiryDTO[]>();
    for (const s of stages) map.set(s.id, []);
    for (const e of enquiries) map.get(e.stage)?.push(e);
    return map;
  }, [enquiries, stages]);

  const tabs: TabItem[] = stages.map((s) => ({
    key: s.id,
    label: `${s.label} (${grouped.get(s.id)?.length ?? 0})`,
  }));

  const items = grouped.get(activeStage) ?? [];

  return (
    <div className="flex h-full flex-col">
      <ScrollableTabs
        tabs={tabs}
        active={activeStage}
        onChange={(k) => setActiveStage(k as EnquiryStage)}
      />

      <div
        // data-scroll-container: this is the real scroller on this screen (<main>
        // doesn't scroll here), so overlays can lock it — see ui/sheet.tsx.
        data-scroll-container
        className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-muted/40 p-3"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {items.map((e) => (
          <div key={e.id}>
            <LeadCard enquiry={e} onClick={() => onSelect(e)} />
            {canDrag && (
              <div className="mt-1 flex justify-end">
                <button
                  onClick={() => setMoveTarget(e)}
                  className="flex min-h-[44px] items-center gap-1 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-secondary"
                >
                  <ArrowLeftRight className="h-4 w-4" /> Move
                </button>
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <p className="px-1 py-10 text-center text-sm text-muted-foreground">
            No leads in this stage.
          </p>
        )}
      </div>

      {/* Bottom-sheet stage picker */}
      <Sheet
        open={!!moveTarget}
        onClose={() => setMoveTarget(null)}
        side="bottom"
        title="Move to stage"
      >
        <div className="p-2">
          {stages.map((s) => {
            const current = s.id === moveTarget?.stage;
            return (
              <button
                key={s.id}
                disabled={current}
                onClick={() => {
                  if (moveTarget) onMove(moveTarget.id, s.id);
                  setMoveTarget(null);
                }}
                className={cn(
                  "flex min-h-[48px] w-full items-center justify-between rounded-lg px-3 text-sm font-medium",
                  current ? "text-muted-foreground" : "hover:bg-secondary",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={cn("h-2.5 w-2.5 rounded-full", s.accent)} />
                  {s.label}
                </span>
                {current && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Check className="h-3.5 w-3.5" /> Current
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}
