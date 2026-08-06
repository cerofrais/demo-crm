import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canAny } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { WhatsAppNumbersManager } from "@/components/whatsapp-numbers/whatsapp-numbers-manager";

export default async function WhatsAppNumbersPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!canAny(roles, ["whatsapp.manage", "whatsapp.view"])) redirect("/leads");
  const canManage = can(roles, "whatsapp.manage");

  return (
    <div>
      <PageHeader
        title="WhatsApp Numbers"
        subtitle={
          canManage
            ? "Connect and manage WhatsApp numbers (self-hosted via Evolution API). Numbers are shared across all roles for now."
            : "Read-only view of connected WhatsApp numbers and their status."
        }
      />
      <WhatsAppNumbersManager canManage={canManage} />
    </div>
  );
}
