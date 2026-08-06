import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canAny } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { LeadAssignmentManager } from "@/components/lead-assignment/lead-assignment-manager";

export default async function LeadAssignmentPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!canAny(roles, ["leads.manage", "lead-assignment.view"])) redirect("/leads");
  const canManage = can(roles, "leads.manage");

  return (
    <div>
      <PageHeader
        title="Lead Assignment"
        subtitle={
          canManage
            ? "Control who newly created leads get assigned to, per channel. Leave a section empty to keep the default (Sales, then Reception, round robin)."
            : "Read-only view of who newly created leads get assigned to, per channel."
        }
      />
      <LeadAssignmentManager canManage={canManage} />
    </div>
  );
}
