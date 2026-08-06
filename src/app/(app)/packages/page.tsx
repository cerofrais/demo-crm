import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canAny } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { PackagesManager } from "@/components/packages/packages-manager";

export const dynamic = "force-dynamic";

export default async function PackagesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!canAny(roles, ["packages.manage", "packages.view"])) redirect("/leads");

  return (
    <div>
      <PageHeader
        title="Packages & Memberships"
        subtitle="Residential, day and corporate programmes used for quotes in the pipeline."
      />
      <PackagesManager canManage={can(roles, "packages.manage")} />
    </div>
  );
}
