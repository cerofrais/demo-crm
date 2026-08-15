"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck, Loader2, Check, AlertTriangle, Search, Users, Grid3x3 } from "lucide-react";
import { Card, Badge, Input, Select, ScrollableTabs, type TabItem } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { PermissionMeta, PermissionGroup } from "@/lib/permissions-catalog";
import { CRM_ROLES, CRM_ROLE_TO_APP_ROLE, type CrmRole } from "@/lib/keycloak-roles";
import { ROLE_LABEL } from "@/lib/rbac";

interface UserRow {
  id: string;
  fullName: string;
  username: string;
  email: string | null;
  enabled: boolean;
  role: CrmRole | null;
  appRole: string | null;
  roleFetchError: boolean;
  permissions: string[];
}

interface PermissionsPayload {
  catalog: PermissionMeta[];
  groupOrder: PermissionGroup[];
  roles: string[];
  matrix: Record<string, string[]>;
  users: UserRow[];
}

export function PermissionsManager() {
  const [data, setData] = useState<PermissionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("matrix");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<PermissionsPayload>("/api/permissions"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load permissions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    if (!data) return [];
    return data.groupOrder
      .map((g) => ({ group: g, perms: data.catalog.filter((p) => p.group === g) }))
      .filter((s) => s.perms.length);
  }, [data]);

  const users = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.users;
    return data.users.filter(
      (u) =>
        u.fullName.toLowerCase().includes(needle) ||
        u.username.toLowerCase().includes(needle) ||
        (u.email ?? "").toLowerCase().includes(needle),
    );
  }, [data, q]);

  async function changeRole(user: UserRow, role: CrmRole) {
    setSaving(user.id);
    setError(null);
    try {
      // Reuses the existing admin route, which already refuses a self-role
      // change and stamps session revocation so the new role takes effect on
      // the user's next request rather than their next sign-in.
      await api.patch(`/api/admin/users/${user.id}`, { role });
      setSaved(user.fullName);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change that role");
    } finally {
      setSaving(null);
    }
  }

  const tabs: TabItem[] = [
    { key: "matrix", label: "Role matrix", icon: <Grid3x3 className="h-3.5 w-3.5" /> },
    { key: "users", label: `Staff (${data?.users.length ?? 0})`, icon: <Users className="h-3.5 w-3.5" /> },
  ];

  if (loading && !data) {
    return (
      <div className="flex justify-center py-16 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4 md:p-6">
      {error && <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</Card>}

      <ScrollableTabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "matrix" && data && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left text-xs font-semibold text-muted-foreground">
                    Permission
                  </th>
                  {data.roles.map((r) => (
                    <th key={r} className="px-3 py-2 text-center text-xs font-semibold text-muted-foreground">
                      {ROLE_LABEL[r as keyof typeof ROLE_LABEL] ?? r}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grouped.map((section) => (
                  // Fragment needs the key: the group header and its rows are
                  // siblings in one <tbody>, so they can't be wrapped in a div.
                  <Fragment key={section.group}>
                    <tr className="border-y border-border bg-secondary/50">
                      <td
                        colSpan={data.roles.length + 1}
                        className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {section.group}
                      </td>
                    </tr>
                    {section.perms.map((p) => (
                      <tr key={p.key} className="border-b border-border last:border-0 hover:bg-muted/20">
                        <td className="sticky left-0 z-10 bg-background px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium">{p.label}</span>
                            {p.sensitive && (
                              <AlertTriangle className="h-3 w-3 text-amber-600" aria-label="Sensitive" />
                            )}
                          </div>
                          <p className="mt-0.5 max-w-md text-[11px] text-muted-foreground">{p.description}</p>
                        </td>
                        {data.roles.map((r) => (
                          <td key={r} className="px-3 py-2 text-center">
                            {data.matrix[r]?.includes(p.key) ? (
                              <Check className="mx-auto h-4 w-4 text-emerald-600" />
                            ) : (
                              <span className="text-muted-foreground/40">—</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === "users" && data && (
        <>
          <div className="relative md:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search staff…"
              className="h-8 pl-8 text-xs"
            />
          </div>

          {users.map((u) => (
            <Card key={u.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{u.fullName}</span>
                    {!u.enabled && <Badge className="bg-secondary text-[10px]">disabled</Badge>}
                    {u.roleFetchError && (
                      <Badge className="bg-amber-100 text-[10px] text-amber-800">role unreadable</Badge>
                    )}
                    {!u.role && !u.roleFetchError && (
                      <Badge className="bg-destructive/10 text-[10px] text-destructive">no role</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {u.username}
                    {u.email ? ` · ${u.email}` : ""}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Select
                    value={u.role ?? ""}
                    disabled={saving === u.id || u.roleFetchError}
                    onChange={(e) => changeRole(u, e.target.value as CrmRole)}
                    className="h-8 w-40 text-xs"
                  >
                    {!u.role && <option value="">— no role —</option>}
                    {CRM_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[CRM_ROLE_TO_APP_ROLE[r]] ?? r}
                      </option>
                    ))}
                  </Select>
                  {saving === u.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </div>
              </div>

              {u.roleFetchError ? (
                <p className="mt-2 text-xs text-amber-700">
                  Keycloak didn&apos;t return this user&apos;s role. This is not the same as having no
                  access — reload before changing anything, so a transient error can&apos;t be
                  mistaken for an unassigned user.
                </p>
              ) : u.permissions.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {data.catalog
                    .filter((p) => u.permissions.includes(p.key))
                    .map((p) => (
                      <Badge
                        key={p.key}
                        className={cn(
                          "text-[10px]",
                          p.sensitive ? "bg-amber-100 text-amber-800" : "bg-secondary",
                        )}
                        title={p.description}
                      >
                        {p.label}
                      </Badge>
                    ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  No permissions — this account can sign in but can&apos;t reach anything.
                </p>
              )}
            </Card>
          ))}

          {!users.length && (
            <Card className="py-12 text-center text-sm text-muted-foreground">No staff match that search.</Card>
          )}
        </>
      )}

      {saved && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-foreground px-4 py-2 text-xs text-background shadow-lg">
          Updated {saved}&apos;s role.
          <button onClick={() => setSaved(null)} className="ml-3 underline">
            Dismiss
          </button>
        </div>
      )}

      <p className="pt-2 text-[11px] text-muted-foreground">
        <ShieldCheck className="mr-1 inline h-3 w-3" />
        Permissions are granted by role, not per person — changing someone&apos;s role is what
        changes their access. You can&apos;t change your own role here; that guard is what stops an
        admin locking themselves out.
      </p>
    </div>
  );
}
