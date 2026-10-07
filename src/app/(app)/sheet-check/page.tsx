import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canAny } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { SheetCheckManager } from "@/components/sheet-check/sheet-check-manager";

export const dynamic = "force-dynamic";

export default async function SheetCheckPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!canAny(roles, ["leads.manage", "lead-assignment.view"])) redirect("/leads");

  return (
    <div>
      <PageHeader
        title="Lead Sheet Check"
        subtitle="Every few days, checks that leads in the lead-ad Google Sheets reached the CRM — adds any that didn't and emails a CSV of them."
      />
      <SheetCheckManager canManage={can(roles, "leads.manage")} />
    </div>
  );
}
