import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { BroadcastStatusManager } from "@/components/broadcast/broadcast-status-manager";

export default async function BroadcastStatusPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!can(roles, "messaging.broadcast")) redirect("/leads");
  const canDelete = can(roles, "leads.manage");

  return (
    <div>
      <PageHeader
        title="Broadcast Status"
        subtitle="Every bulk WhatsApp trigger — per-recipient delivered/read/failed status, and errors for anything that didn't go out."
      />
      <BroadcastStatusManager canDelete={canDelete} />
    </div>
  );
}
