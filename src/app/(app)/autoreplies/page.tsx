import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canAny } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { AutoReplyManager } from "@/components/whatsapp-autoreply/autoreply-manager";

export default async function AutoRepliesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  // The page now hosts email auto-replies as well as WhatsApp ones, so it has
  // to admit the roles that manage email — a Manager holds leads.manage but
  // no WhatsApp permission at all, and would otherwise have lost the email
  // rules entirely when they moved here from the templates page.
  if (!canAny(roles, ["whatsapp.manage", "whatsapp.view", "leads.manage", "templates.view"])) {
    redirect("/leads");
  }
  const canManage = can(roles, "whatsapp.manage");
  // Separate on purpose: a Manager may edit email replies but not WhatsApp
  // ones, so the two halves of this page have different write rights.
  const canManageEmail = canAny(roles, ["leads.manage", "whatsapp.manage"]);

  return (
    <div>
      <PageHeader
        title="Auto-Reply"
        subtitle={
          canManage
            ? "Every automatic reply in one place: welcome messages for brand-new customers (WhatsApp per number, plus an onboarding email), and trigger-word replies on both WhatsApp and email."
            : "Read-only view of configured auto-replies."
        }
      />
      <AutoReplyManager canManage={canManage} canManageEmail={canManageEmail} />
    </div>
  );
}
