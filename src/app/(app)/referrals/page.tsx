import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canAny } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { ReferralsManager } from "@/components/referrals/referrals-manager";

export const dynamic = "force-dynamic";

export default async function ReferralsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!canAny(roles, ["referrals.manage", "referrals.view"])) redirect("/leads");
  const canManage = can(roles, "referrals.manage");

  return (
    <div>
      <PageHeader
        title="Referrals"
        subtitle={
          canManage
            ? "Generate trackable referral codes with QR links and monitor redemptions."
            : "Read-only view of referral codes, QR links, and redemptions."
        }
      />
      <ReferralsManager canManage={canManage} />
    </div>
  );
}
