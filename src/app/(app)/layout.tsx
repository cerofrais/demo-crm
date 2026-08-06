import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { navFor, primaryRole, ROLE_LABEL } from "@/lib/rbac";
import { AppShell } from "@/components/app/app-shell";
import { isSessionRevoked } from "@/lib/session-revocation";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Page-navigation-time revocation check. requireSession() covers API calls,
  // but a user staring at a rendered page wouldn't hit an API — this catches
  // them on their next navigation. RSC layouts can't mutate cookies, so we
  // bounce through /api/auth/force-signout which clears them and 302s /login.
  const reason = await isSessionRevoked(session.user.sub, session.iat);
  if (reason) redirect(`/api/auth/force-signout?reason=${reason}`);

  const roles = session.roles ?? [];
  const nav = navFor(roles).map(({ href, label, icon }) => ({ href, label, icon }));
  const role = primaryRole(roles);

  return (
    <AppShell
      nav={nav}
      user={{
        name: session.user.name ?? "Meridian Staff",
        email: session.user.email ?? undefined,
        role: role ? ROLE_LABEL[role] : "Staff",
      }}
    >
      {children}
    </AppShell>
  );
}
