import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { HealthWorkspace } from "@/components/health/health-workspace";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!can(session.roles ?? [], "health.view")) redirect("/leads");

  return <HealthWorkspace />;
}
