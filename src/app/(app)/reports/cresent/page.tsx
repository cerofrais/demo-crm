import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { CresentReport } from "@/components/reports/cresent-report";

export const dynamic = "force-dynamic";

export default async function CresentReportPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!can(roles, "reports.allStaff")) redirect("/reports");

  return (
    <div>
      <PageHeader
        title="Cresent"
        subtitle="Weekly lead report — leads with any of the chosen tags, and each one's first call or message with two follow-ups. Emailed every Monday."
      />
      {/* Changing recipients or sending needs messaging.send too, same as
          the Marketing report's actions. */}
      <CresentReport canEdit={can(roles, "messaging.send")} />
    </div>
  );
}
