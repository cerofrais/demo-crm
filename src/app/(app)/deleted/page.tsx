import { PageHeader } from "@/components/app/page-header";
import { DeletedLeadsExplorer } from "@/components/deleted/deleted-leads-explorer";

export const dynamic = "force-dynamic";

export default function DeletedLeadsPage() {
  return (
    <div>
      <PageHeader
        title="Deleted Leads"
        subtitle="Soft-deleted leads and everything kept with them — activity, emails, WhatsApp chats, call recordings, remarks, tasks and documents. Read-only, admin only."
      />
      <DeletedLeadsExplorer />
    </div>
  );
}
