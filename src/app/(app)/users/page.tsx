import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canAny } from "@/lib/rbac";
import { UsersManager } from "@/components/users/users-manager";

export default async function UsersPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = session.roles ?? [];
  if (!canAny(roles, ["users.manage", "users.view"])) redirect("/leads");

  return <UsersManager canManage={can(roles, "users.manage")} />;
}
