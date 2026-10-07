import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canMutateLeads, canViewLeadStage, isAdmin } from "@/lib/rbac";
import { STAGES } from "@/lib/kanban";
import { LeadsWorkspace } from "@/components/leads/leads-workspace";
import type { EnquiryDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!can(roles, "leads.view")) redirect("/");

  // DEMO BRANCH: no server-side DB to read from — the board's own client-side
  // fetch (leads-workspace.tsx's debounced refetch, fires ~250ms after mount)
  // hits the fetch interceptor and populates the demo data almost immediately.
  const initial: EnquiryDTO[] = [];

  return (
    <LeadsWorkspace
      initial={initial}
      canManage={can(roles, "leads.manage")}
      isAdmin={isAdmin(roles)}
      canFilterByPerson={can(roles, "leads.manage") || can(roles, "reports.allStaff")}
      canWorkLeads={canMutateLeads(roles)}
      canDelete={can(roles, "leads.delete")}
      canCreate={can(roles, "leads.manage") || can(roles, "leads.ownOnly")}
      canDoctorDecide={can(roles, "leads.doctorDecision")}
      visibleStages={STAGES.filter((s) => canViewLeadStage(roles, s.id))}
      currentSub={session.user.sub}
    />
  );
}
