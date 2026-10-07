import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { PageHeader } from "@/components/app/page-header";
import { aiConfig, aiFeatureEnabled } from "@/lib/ai/config";
import { AskDbConsole } from "@/components/ask-db/ask-db-console";
import { ALLOWED_TABLES, SAMPLE_QUESTIONS } from "@/lib/ask-db-catalog";

export const dynamic = "force-dynamic";

export default async function AskDbPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!can(session.roles ?? [], "db.query")) redirect("/leads");

  return (
    <div>
      <PageHeader
        title="Ask the Database"
        subtitle="Ask in plain English. A question about the business comes back as a table with the SQL behind it; a question about one lead comes back as a short account of what happened, with the entries it rests on."
      />
      <AskDbConsole
        enabled={aiFeatureEnabled("askDb")}
        model={aiConfig().model}
        samples={SAMPLE_QUESTIONS}
        tables={[...ALLOWED_TABLES]}
      />
    </div>
  );
}
