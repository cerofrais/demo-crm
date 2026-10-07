import Link from "next/link";

const TABS = [
  { key: "users", label: "Users", href: "/users" },
  { key: "activity", label: "Activity monitor", href: "/users/activity" },
] as const;

/** Sub-navigation for the Users section — each view is its own route. */
export function UsersTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <div className="flex gap-1 border-b border-border px-4 md:px-6">
      {TABS.map((t) =>
        t.key === active ? (
          <span key={t.key} className="border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-foreground">
            {t.label}
          </span>
        ) : (
          <Link
            key={t.key}
            href={t.href}
            className="border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            {t.label}
          </Link>
        ),
      )}
    </div>
  );
}
