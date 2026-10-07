import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { canAny } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { UsersTabs } from "@/components/users/users-tabs";
import { ActivityMonitor } from "@/components/users/activity-monitor";

export const dynamic = "force-dynamic";

export default async function UserActivityPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canAny(session.roles ?? [], ["users.manage", "users.view"])) redirect("/leads");

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="How active each staff member was through the day, from the activity log in 10-minute slots."
      />
      <UsersTabs active="activity" />
      <ActivityMonitor />
    </div>
  );
}
