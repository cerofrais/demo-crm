"use client";

import { useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { STAGES, type StageDef } from "@/lib/kanban";
import type { EnquiryStage } from "@prisma/client";
import type { EnquiryDTO } from "@/lib/types";
import { LeadCard } from "./lead-card";
import { HorizontalScrollbar } from "@/components/ui";
import { cn } from "@/lib/utils";

function DraggableCard({
  enquiry,
  onClick,
  canDrag,
}: {
  enquiry: EnquiryDTO;
  onClick: () => void;
  canDrag: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: enquiry.id,
    data: { stage: enquiry.stage },
    disabled: !canDrag,
  });
  return (
    <div
      ref={setNodeRef}
      {...(canDrag ? listeners : {})}
      {...(canDrag ? attributes : {})}
      className={cn(canDrag && "touch-none", isDragging && "opacity-40")}
    >
      <LeadCard enquiry={enquiry} onClick={onClick} />
    </div>
  );
}

function Column({
  stage,
  label,
  accent,
  count,
  children,
}: {
  stage: EnquiryStage;
  label: string;
  accent: string;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div className="flex w-[280px] shrink-0 flex-col">
      <div className="rounded-t-xl border border-b-0 border-border bg-card">
        <div className={cn("h-1 rounded-t-xl", accent)} />
        <div className="flex items-center justify-between px-3 py-2.5">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground">
            {label}
          </h3>
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
            {count}
          </span>
        </div>
      </div>
      <div
        ref={setNodeRef}
        // data-scroll-container: columns are the real scrollers here (<main>
        // doesn't scroll on this screen) — lets overlays lock them.
        data-scroll-container
        className={cn(
          "scrollbar-thin flex-1 space-y-2 overflow-y-auto rounded-b-xl border border-t-0 border-border bg-muted/40 p-2 transition-colors",
          isOver && "bg-brand-50 ring-2 ring-inset ring-brand-300",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function KanbanBoard({
  enquiries,
  onMove,
  onSelect,
  stages = STAGES,
  canDrag = true,
}: {
  enquiries: EnquiryDTO[];
  onMove: (id: string, stage: EnquiryStage) => void;
  onSelect: (e: EnquiryDTO) => void;
  /** Columns to render — defaults to the full pipeline. */
  stages?: StageDef[];
  /** False disables dragging entirely — a read-only Viewer. */
  canDrag?: boolean;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const grouped = useMemo(() => {
    const map = new Map<EnquiryStage, EnquiryDTO[]>();
    for (const s of stages) map.set(s.id, []);
    for (const e of enquiries) map.get(e.stage)?.push(e);
    return map;
  }, [enquiries, stages]);

  const active = enquiries.find((e) => e.id === activeId) ?? null;

  function handleStart(ev: DragStartEvent) {
    setActiveId(String(ev.active.id));
  }
  function handleEnd(ev: DragEndEvent) {
    setActiveId(null);
    const { active, over } = ev;
    if (!over) return;
    const target = over.id as EnquiryStage;
    const fromStage = active.data.current?.stage as EnquiryStage | undefined;
    if (target && fromStage && target !== fromStage) {
      onMove(String(active.id), target);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleStart}
      onDragEnd={handleEnd}
    >
      <div className="flex h-full min-h-0 flex-col">
      {/* Marked too so an open overlay locks horizontal panning, not just the
          vertical column scroll. */}
      <div
        ref={scrollRef}
        data-scroll-container
        className="scrollbar-none flex min-h-0 flex-1 gap-3 overflow-x-auto p-4"
      >
        {stages.map((s) => {
          const items = grouped.get(s.id) ?? [];
          return (
            <Column
              key={s.id}
              stage={s.id}
              label={s.label}
              accent={s.accent}
              count={items.length}
            >
              {items.map((e) => (
                <DraggableCard
                  key={e.id}
                  enquiry={e}
                  onClick={() => onSelect(e)}
                  canDrag={canDrag}
                />
              ))}
              {items.length === 0 && (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                  Drop cards here
                </p>
              )}
            </Column>
          );
        })}
      </div>

      <HorizontalScrollbar targetRef={scrollRef} className="mx-4 mb-3 shrink-0" />
      </div>

      <DragOverlay>
        {active ? (
          <div className="w-[264px]">
            <LeadCard enquiry={active} dragging />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
