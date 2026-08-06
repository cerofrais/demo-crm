import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { TasksList } from "@/components/tasks/tasks-list";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!can(roles, "leads.view")) redirect("/");

  return (
    <div>
      <PageHeader
        title="Tasks & Reminders"
        subtitle="Your 6-2-1 follow-ups (call within 6h · 2 days · 1 week). Overdue items are flagged."
      />
      <TasksList canSeeAll={can(roles, "reports.allStaff")} />
    </div>
  );
}
