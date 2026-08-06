import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canAny } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { MessageTemplatesManager } from "@/components/message-templates/message-templates-manager";

export default async function MessageTemplatesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!canAny(roles, ["leads.manage", "templates.view"])) redirect("/leads");
  const canManage = can(roles, "leads.manage");

  return (
    <div>
      <PageHeader
        title="Message Templates"
        subtitle={
          canManage
            ? "Canned messages staff can insert when emailing or WhatsApp-ing a lead, individually or in bulk."
            : "Read-only view of the canned messages staff can insert when emailing or WhatsApp-ing a lead."
        }
      />
      <MessageTemplatesManager canManage={canManage} />
    </div>
  );
}
