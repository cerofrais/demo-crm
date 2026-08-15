import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { MarketingReports } from "@/components/reports/marketing-reports";

export const dynamic = "force-dynamic";

export default async function MarketingReportPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Same gate as the rest of org-wide reporting; the page's own actions
  // (generate / email) additionally require messaging.send server-side.
  if (!can(session.roles ?? [], "reports.allStaff")) redirect("/reports");

  const canSend = can(session.roles ?? [], "messaging.send");

  return (
    <div>
      <PageHeader
        title="Marketing"
        subtitle="Daily lead reports for the management team — one CSV per day, generated automatically and emailed to the CEO."
      />
      <MarketingReports canSend={canSend} />
    </div>
  );
}
