import { prisma } from "./prisma";
import type { AiDecisionKind, Prisma } from "@prisma/client";

export interface AiDecisionListItemDTO {
  id: string;
  kind: AiDecisionKind;
  callId: string | null;
  enquiryId: string | null;
  guestId: string | null;
  guestName: string | null;
  provider: string;
  model: string;
  success: boolean;
  errorMessage: string | null;
  durationMs: number | null;
  triggeredBy: string | null;
  triggeredByName: string | null;
  createdAt: string;
}

export interface AiDecisionDetailDTO extends AiDecisionListItemDTO {
  promptSystem: string;
  promptUser: string;
  output: unknown;
}

type RawRow = {
  id: string;
  kind: AiDecisionKind;
  callId: string | null;
  enquiryId: string | null;
  guestId: string | null;
  provider: string;
  model: string;
  success: boolean;
  errorMessage: string | null;
  durationMs: number | null;
  triggeredBy: string | null;
  triggeredByName: string | null;
  createdAt: Date;
  promptSystem?: string;
  promptUser?: string;
  output?: Prisma.JsonValue;
  guest: { fullName: string } | null;
  enquiry: { guest: { fullName: string } } | null;
  call: { guest: { fullName: string } | null } | null;
};

const LIST_INCLUDE = {
  guest: { select: { fullName: true } },
  enquiry: { select: { guest: { select: { fullName: true } } } },
  call: { select: { guest: { select: { fullName: true } } } },
} as const;

function resolveGuestName(row: RawRow): string | null {
  return row.guest?.fullName ?? row.enquiry?.guest.fullName ?? row.call?.guest?.fullName ?? null;
}

function toListDTO(row: RawRow): AiDecisionListItemDTO {
  return {
    id: row.id,
    kind: row.kind,
    callId: row.callId,
    enquiryId: row.enquiryId,
    guestId: row.guestId,
    guestName: resolveGuestName(row),
    provider: row.provider,
    model: row.model,
    success: row.success,
    errorMessage: row.errorMessage,
    durationMs: row.durationMs,
    triggeredBy: row.triggeredBy,
    triggeredByName: row.triggeredByName,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface AiDecisionFilters {
  kind?: AiDecisionKind;
  success?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  cursor?: string; // createdAt ISO
}

export async function listAiDecisions(
  filters: AiDecisionFilters,
  limit = 30,
): Promise<{ items: AiDecisionListItemDTO[]; nextCursor: string | null }> {
  const rows = await prisma.aiDecision.findMany({
    where: {
      ...(filters.kind && { kind: filters.kind }),
      ...(filters.success !== undefined && { success: filters.success }),
      ...((filters.dateFrom || filters.dateTo) && {
        createdAt: {
          ...(filters.dateFrom && { gte: filters.dateFrom }),
          ...(filters.dateTo && { lte: filters.dateTo }),
        },
      }),
      ...(filters.cursor && { createdAt: { lt: new Date(filters.cursor) } }),
    },
    include: LIST_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: items.map(toListDTO),
    nextCursor: hasMore ? items[items.length - 1].createdAt.toISOString() : null,
  };
}

export async function getAiDecision(id: string): Promise<AiDecisionDetailDTO | null> {
  const row = await prisma.aiDecision.findUnique({
    where: { id },
    include: LIST_INCLUDE,
  });
  if (!row) return null;
  return {
    ...toListDTO(row),
    promptSystem: row.promptSystem,
    promptUser: row.promptUser,
    output: row.output,
  };
}

export async function aiDecisionStats(): Promise<{
  total: number;
  success: number;
  failed: number;
  byKind: Record<string, number>;
}> {
  const [total, success, byKind] = await Promise.all([
    prisma.aiDecision.count(),
    prisma.aiDecision.count({ where: { success: true } }),
    prisma.aiDecision.groupBy({ by: ["kind"], _count: { id: true } }),
  ]);
  return {
    total,
    success,
    failed: total - success,
    byKind: Object.fromEntries(byKind.map((k) => [k.kind, k._count.id])),
  };
}
