import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { GuestSearch } from "@/components/guests/guest-search";

export const dynamic = "force-dynamic";

export default async function GuestsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!can(roles, "guests.view") && !can(roles, "health.view")) redirect("/");

  return (
    <div>
      <PageHeader
        title="Guests"
        subtitle="Search any guest by name, phone, email or tag (Doctor/Manager lookup)."
      />
      <GuestSearch
        canViewHealth={can(roles, "health.view")}
        canViewLeads={can(roles, "leads.view")}
        canViewDeletedLeads={can(roles, "leads.delete")}
        canDelete={can(roles, "guests.delete")}
        canBulkImport={can(roles, "leads.manage")}
        canBroadcast={can(roles, "messaging.broadcast")}
        canEditTags={can(roles, "leads.manage")}
        canBulkEmail={can(roles, "messaging.broadcast")}
        canCreateGuest={can(roles, "leads.manage")}
        canBlock={can(roles, "leads.manage")}
        canEditGuest={can(roles, "leads.manage")}
      />
    </div>
  );
}
