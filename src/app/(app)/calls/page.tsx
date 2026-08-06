import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { CallsWorkspace } from "@/components/calls/calls-workspace";

export default async function CallsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!can(roles, "reports.allStaff")) redirect("/leads");

  return <CallsWorkspace canCreateLead={can(roles, "leads.manage") || can(roles, "leads.ownOnly")} />;
}
