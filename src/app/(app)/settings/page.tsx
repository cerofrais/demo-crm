import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { primaryRole, ROLE_LABEL } from "@/lib/rbac";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/app/page-header";
import { PhoneEditor } from "./phone-editor";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = primaryRole(session.roles ?? []);

  return (
    <div>
      <PageHeader title="Settings" subtitle="Your profile & workspace." />
      <div className="max-w-2xl space-y-4 p-4 md:p-6">
        <Card className="p-6">
          <h3 className="mb-4 text-sm font-semibold">Profile</h3>
          <dl className="space-y-3 text-sm">
            <Row label="Name" value={session.user.name ?? "—"} />
            <Row label="Email" value={session.user.email ?? "—"} />
            <Row label="Role" value={role ? ROLE_LABEL[role] : "Staff"} />
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            Profile, password and MFA are managed in Keycloak. Use the Keycloak
            account console to update them.
          </p>
        </Card>

        <PhoneEditor />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-border pb-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
