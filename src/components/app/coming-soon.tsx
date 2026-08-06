import { Construction } from "lucide-react";
import { PageHeader } from "./page-header";

/** Consistent placeholder for routes scaffolded but built in a later iteration. */
export function ComingSoon({
  title,
  subtitle,
  note,
}: {
  title: string;
  subtitle?: string;
  note?: string;
}) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
          <Construction className="h-7 w-7" />
        </div>
        <h2 className="text-base font-semibold text-foreground">
          Scaffolded — building next
        </h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {note ??
            "This module is wired into navigation, RBAC and the data model. The UI lands in an upcoming iteration."}
        </p>
      </div>
    </div>
  );
}
