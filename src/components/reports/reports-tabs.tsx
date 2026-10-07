import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "overview", label: "Overview", href: "/reports" },
  { key: "marketing", label: "Marketing", href: "/reports/marketing" },
  { key: "cresent", label: "Cresent", href: "/reports/cresent" },
] as const;

/** Sub-navigation between the report views — each is its own route. */
export function ReportsTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <div className="no-print flex gap-1 border-b border-border">
      {TABS.map((t) =>
        t.key === active ? (
          <span key={t.key} className="border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-foreground">
            {t.label}
          </span>
        ) : (
          <Link
            key={t.key}
            href={t.href}
            className={cn("border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground")}
          >
            {t.label}
          </Link>
        ),
      )}
    </div>
  );
}
