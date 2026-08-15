import { PageHeader } from "@/components/app/page-header";
import { PermissionsManager } from "@/components/permissions/permissions-manager";

export const dynamic = "force-dynamic";

export default function PermissionsPage() {
  return (
    <div>
      <PageHeader
        title="Permissions"
        subtitle="What every role can do, and exactly what each staff member's own role grants them. Change someone's access by changing their role. Admin only."
      />
      <PermissionsManager />
    </div>
  );
}
