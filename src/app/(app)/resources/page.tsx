import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canDeleteDocuments } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { DocumentManager } from "@/components/documents/document-manager";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (
    !can(roles, "documents.operational") &&
    !can(roles, "documents.medical") &&
    !can(roles, "documents.private")
  ) {
    redirect("/");
  }

  return (
    <div>
      <PageHeader
        title="Resources"
        subtitle="Shared library — brochures, consent forms and operational documents. Upload here or attach files directly to a lead/guest."
      />
      <div className="p-6">
        <DocumentManager scope={{ kind: "general" }} canDelete={canDeleteDocuments(roles)} />
      </div>
    </div>
  );
}
