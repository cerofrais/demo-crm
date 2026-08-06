import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";

/** Landing: route each role to its natural first screen (tech spec — Stories §1). */
export default async function Home() {
  const session = await auth();
  if (!session) redirect("/login");
  const roles = session.roles ?? [];
  // Admin/Manager land on the analytics dashboard; everyone else on the board.
  if (can(roles, "dashboard.view")) redirect("/dashboard");
  if (can(roles, "health.view")) redirect("/health");
  redirect("/leads");
}
