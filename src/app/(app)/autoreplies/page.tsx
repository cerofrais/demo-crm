import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canAny } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { AutoReplyManager } from "@/components/whatsapp-autoreply/autoreply-manager";

export default async function AutoRepliesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!canAny(roles, ["whatsapp.manage", "whatsapp.view"])) redirect("/leads");
  const canManage = can(roles, "whatsapp.manage");

  return (
    <div>
      <PageHeader
        title="Auto-Reply"
        subtitle={
          canManage
            ? "Automatic WhatsApp replies, keyed off a trigger word or sent for every inbound message."
            : "Read-only view of configured WhatsApp auto-replies."
        }
      />
      <AutoReplyManager canManage={canManage} />
    </div>
  );
}
