import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { ReportsWorkspace } from "@/components/reports/reports-workspace";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!can(session.roles ?? [], "reports.own")) redirect("/leads");

  return (
    <div>
      <div className="no-print">
        <PageHeader
          title="Reports"
          subtitle="Front-office performance and the source × stage matrix, both filterable by date."
        />
      </div>
      <ReportsWorkspace />
    </div>
  );
}
