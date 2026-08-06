import { prisma } from "./prisma";

/**
 * Round-robin cursor over active Sales + Reception staff for automatic
 * new-lead assignment — both roles work leads, so both are in the same
 * rotation rather than one being an emergency-only fallback. Simple
 * rotation — not load-aware — cycling through reps in a stable order and
 * remembering the last one assigned via a singleton cursor row
 * (LeadRoutingState). Returns null (stays unassigned, today's behavior) if
 * no staff exist in either role.
 */
export async function assignNextRep(): Promise<{ sub: string; name: string } | null> {
  const reps = await prisma.staffProfile.findMany({
    where: { role: { in: ["SALES", "RECEPTION"] } },
    orderBy: { keycloakId: "asc" },
    select: { keycloakId: true, displayName: true },
  });
  if (!reps.length) return null;

  const state = await prisma.leadRoutingState.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });

  let nextIndex = 0;
  if (state.lastAssignedSub) {
    const lastIndex = reps.findIndex((r) => r.keycloakId === state.lastAssignedSub);
    nextIndex = lastIndex === -1 ? 0 : (lastIndex + 1) % reps.length;
  }
  const next = reps[nextIndex];

  await prisma.leadRoutingState.update({
    where: { id: "singleton" },
    data: { lastAssignedSub: next.keycloakId },
  });

  return { sub: next.keycloakId, name: next.displayName };
}
