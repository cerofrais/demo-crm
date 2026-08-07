import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LoginButton } from "./login-button";
import { SiteFooter } from "@/components/app/site-footer";

export default async function LoginPage() {
  const session = await auth();
  if (session) redirect("/");

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-br from-brand-50 via-background to-brand-100">
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-lg">
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-700 text-2xl font-semibold text-white">
              M
            </div>
            <h1 className="text-xl font-semibold text-foreground">
              Meridian Wellness CRM
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Interactive demo — no real data, everything below is generated
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              Built by{" "}
              <a
                href="https://ascent-i-tech.com/#contact"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-brand-700 underline-offset-2 hover:underline"
              >
                Ascent-Intelligent-Technologies
              </a>
            </p>
          </div>

          <LoginButton />

          <p className="mt-6 text-center text-xs text-muted-foreground">
            This is a self-contained demo. All data lives only in your browser
            and resets if you clear site data.
          </p>
        </div>
      </main>

      <SiteFooter className="bg-background/70" />
    </div>
  );
}
