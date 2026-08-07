const COMPANY = "Ascent-Intelligent-Technologies";
const CONTACT_URL = "https://ascent-i-tech.com/#contact";

/**
 * Site-wide attribution bar. Rendered once inside the app shell (so it sits
 * under every authenticated page) and again on the login screen, which lives
 * outside the shell.
 */
export function SiteFooter({ className }: { className?: string }) {
  const year = new Date().getFullYear();
  return (
    <footer
      className={[
        "no-print flex shrink-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 border-t border-border bg-background px-4 py-2 text-center text-[11px] text-muted-foreground",
        className ?? "",
      ].join(" ")}
    >
      <span>
        © {year} {COMPANY}. All rights reserved.
      </span>
      <span className="hidden sm:inline" aria-hidden="true">
        ·
      </span>
      <span>
        A product of{" "}
        <a
          href={CONTACT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          {COMPANY}
        </a>
        {" — "}
        <a
          href={CONTACT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          contact us
        </a>
        .
      </span>
    </footer>
  );
}
