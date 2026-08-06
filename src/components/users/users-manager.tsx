"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Users as UsersIcon, Plus, Loader2, X, Pencil, Trash2, KeyRound,
  Copy, Check, ShieldAlert, Search, PhoneIncoming, Trash,
} from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Card, Badge, Button, Input, Select, Dialog } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, copyToClipboard } from "@/lib/utils";
import { validateIndianPhone } from "@/lib/validation";
import type { CrmRole } from "@/lib/keycloak-roles";

type CallRoutingScope = "reception" | "sales" | "reception_sales" | "all";

const ROUTING_SCOPE_LABEL: Record<CallRoutingScope, string> = {
  reception: "Reception only",
  sales: "Sales only",
  reception_sales: "Reception + Sales",
  all: "All staff",
};

const ROUTING_SCOPE_DESCRIPTION: Record<CallRoutingScope, string> = {
  reception: "Only Front Office (Reception) staff are rung for incoming calls.",
  sales: "Only Sales staff are rung for incoming calls.",
  reception_sales: "Reception and Sales staff are rung for incoming calls.",
  all: "Any online staff member with a phone number can be rung for incoming calls.",
};

interface StaffUser {
  id: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  phone: string | null;
  enabled: boolean;
  role: CrmRole | null;
  appRole: string | null;
  createdAt: string | null;
}

const ROLE_LABEL: Record<CrmRole, string> = {
  "crm-admin": "Admin",
  "crm-doctor": "Doctor",
  "crm-manager": "Manager",
  "crm-reception": "Reception",
  "crm-sales": "Sales",
  "crm-staff": "Staff",
  "crm-viewer": "Viewer (Read-Only)",
};

const ROLE_COLOR: Record<CrmRole, string> = {
  "crm-admin": "bg-rose-100 text-rose-800",
  "crm-doctor": "bg-purple-100 text-purple-800",
  "crm-manager": "bg-blue-100 text-blue-800",
  "crm-reception": "bg-brand-100 text-brand-700",
  "crm-sales": "bg-amber-100 text-amber-800",
  "crm-staff": "bg-secondary text-secondary-foreground",
  "crm-viewer": "bg-slate-100 text-slate-700",
};

const ROLES: CrmRole[] = ["crm-admin", "crm-manager", "crm-reception", "crm-sales", "crm-doctor", "crm-staff", "crm-viewer"];

function RoleBadge({ role }: { role: CrmRole | null }) {
  if (!role) return <span className="text-xs text-muted-foreground">No role</span>;
  return <Badge className={cn("text-xs", ROLE_COLOR[role])}>{ROLE_LABEL[role]}</Badge>;
}

function filterUsers(users: StaffUser[], search: string): StaffUser[] {
  const q = search.trim().toLowerCase();
  if (!q) return users;
  return users.filter((u) =>
    [u.fullName, u.username, u.email, u.phone, u.role ? ROLE_LABEL[u.role] : null]
      .some((f) => f?.toLowerCase().includes(q)),
  );
}

export function UsersManager({ canManage }: { canManage: boolean }) {
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [deleting, setDeleting] = useState<StaffUser | null>(null);
  const [resettingPassword, setResettingPassword] = useState<StaffUser | null>(null);
  const [reveal, setReveal] = useState<{ username: string; password: string } | null>(null);
  const [search, setSearch] = useState("");
  const [callRouting, setCallRouting] = useState<{ scope: CallRoutingScope } | null>(null);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [leadDeletion, setLeadDeletion] = useState<{ autoDeleteDays: number } | null>(null);
  const [deletionDaysInput, setDeletionDaysInput] = useState("");
  const [deletionBusy, setDeletionBusy] = useState(false);

  const filtered = filterUsers(users, search);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await api.get<StaffUser[]>("/api/admin/users"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get<{ scope: CallRoutingScope }>("/api/admin/call-routing").then(setCallRouting).catch(() => {});
    api.get<{ autoDeleteDays: number }>("/api/admin/lead-deletion").then((s) => {
      setLeadDeletion(s);
      setDeletionDaysInput(String(s.autoDeleteDays));
    }).catch(() => {});
  }, []);

  async function changeCallRouting(scope: CallRoutingScope) {
    if (!callRouting || routingBusy || !canManage) return;
    const prev = callRouting;
    setRoutingBusy(true);
    setCallRouting({ scope });
    try {
      await api.patch("/api/admin/call-routing", { scope });
    } catch {
      setCallRouting(prev); // revert on failure
    } finally {
      setRoutingBusy(false);
    }
  }

  async function saveDeletionDays() {
    if (!canManage) return;
    const days = parseInt(deletionDaysInput, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365 || deletionBusy) return;
    setDeletionBusy(true);
    try {
      const updated = await api.patch<{ autoDeleteDays: number }>("/api/admin/lead-deletion", {
        autoDeleteDays: days,
      });
      setLeadDeletion(updated);
      setDeletionDaysInput(String(updated.autoDeleteDays));
    } catch {
      if (leadDeletion) setDeletionDaysInput(String(leadDeletion.autoDeleteDays));
    } finally {
      setDeletionBusy(false);
    }
  }

  async function toggleEnabled(u: StaffUser) {
    if (!canManage) return;
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await api.patch(`/api/admin/users/${u.id}`, { enabled: !u.enabled });
    } catch {
      load();
    }
  }

  async function confirmResetPassword() {
    if (!resettingPassword) return;
    const result = await api.post<{ temporaryPassword: string }>(
      `/api/admin/users/${resettingPassword.id}/reset-password`,
      {},
    );
    setReveal({ username: resettingPassword.username, password: result.temporaryPassword });
    setResettingPassword(null);
  }

  async function confirmDelete() {
    if (!deleting) return;
    await api.delete(`/api/admin/users/${deleting.id}`);
    setDeleting(null);
    load();
  }

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle={
          canManage
            ? "Create and manage staff accounts and their roles. Backed by Keycloak — identity lives there, not in the CRM database."
            : "Read-only view of staff accounts and their roles. Backed by Keycloak — identity lives there, not in the CRM database."
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3 p-4 pb-0 md:p-6 md:pb-0">
        <p className="order-2 shrink-0 text-xs text-muted-foreground md:order-1">
          {filtered.length} of {users.length} account{users.length === 1 ? "" : "s"}
        </p>
        <div className="order-1 flex flex-1 items-center gap-3 md:order-2 md:flex-none">
          <div className="relative flex-1 md:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, username…"
              className="w-full pl-8 md:w-64"
            />
          </div>
          {canManage && (
            <Button onClick={() => setCreateOpen(true)} className="shrink-0 gap-1.5">
              <Plus className="h-4 w-4" /> <span className="hidden sm:inline">New user</span>
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-3 px-4 pt-4 md:px-6">
        <Card className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <PhoneIncoming className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">Inbound call routing</p>
              <p className="text-xs text-muted-foreground">
                {callRouting ? ROUTING_SCOPE_DESCRIPTION[callRouting.scope] : ""}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {routingBusy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <Select
              value={callRouting?.scope ?? "reception"}
              onChange={(e) => changeCallRouting(e.target.value as CallRoutingScope)}
              disabled={!callRouting || routingBusy || !canManage}
              className="h-8 w-44 text-xs"
            >
              {(Object.keys(ROUTING_SCOPE_LABEL) as CallRoutingScope[]).map((scope) => (
                <option key={scope} value={scope}>{ROUTING_SCOPE_LABEL[scope]}</option>
              ))}
            </Select>
          </div>
        </Card>

        <Card className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Trash className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">Dead-lead auto-delete</p>
              <p className="text-xs text-muted-foreground">
                Once a Manager/Admin approves deleting a Dead lead, it&apos;s soft-deleted
                automatically after this many days.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              type="number"
              min={1}
              max={365}
              value={deletionDaysInput}
              onChange={(e) => setDeletionDaysInput(e.target.value)}
              disabled={!canManage}
              className="h-8 w-16 text-center"
            />
            <span className="text-xs text-muted-foreground">days</span>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                onClick={saveDeletionDays}
                disabled={
                  !leadDeletion ||
                  deletionBusy ||
                  deletionDaysInput === String(leadDeletion.autoDeleteDays)
                }
              >
                {deletionBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
            )}
          </div>
        </Card>
      </div>

      <div className="p-4 md:p-6">
        <Card className="overflow-hidden">
          {loading && !users.length ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <UsersIcon className="mr-2 h-5 w-5 animate-pulse" /> Loading users…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
              <ShieldAlert className="h-10 w-10 opacity-30" />
              <p className="max-w-md text-sm">{error}</p>
              <p className="max-w-md text-xs">
                This usually means the Keycloak client&apos;s service account isn&apos;t enabled yet — see
                docs/16-user-management.md.
              </p>
              <Button size="sm" variant="outline" onClick={load}>Retry</Button>
            </div>
          ) : !users.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <UsersIcon className="h-10 w-10 opacity-20" />
              <p>No staff accounts found.</p>
            </div>
          ) : !filtered.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <Search className="h-10 w-10 opacity-20" />
              <p>No accounts match &quot;{search}&quot;.</p>
              <Button size="sm" variant="outline" onClick={() => setSearch("")}>Clear search</Button>
            </div>
          ) : (
            <>
            {/* Phone: divided list */}
            <div className="divide-y divide-border md:hidden">
              {filtered.map((u) => (
                <div key={u.id} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{u.fullName}</p>
                      <p className="truncate text-xs text-muted-foreground">@{u.username}</p>
                    </div>
                    <RoleBadge role={u.role} />
                  </div>
                  {(u.email || u.phone) && (
                    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {u.email && <p className="truncate">{u.email}</p>}
                      {u.phone && <p>{u.phone}</p>}
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between">
                    <button
                      onClick={() => toggleEnabled(u)}
                      disabled={!canManage}
                      className={cn(
                        // 44px tap target on phone; compact again from lg up.
                        "inline-flex min-h-[44px] items-center rounded px-3 text-xs font-medium lg:min-h-0 lg:px-1.5 lg:py-1",
                        u.enabled ? "bg-brand-100 text-brand-700" : "bg-gray-100 text-gray-500",
                        !canManage && "cursor-default",
                      )}
                    >
                      {u.enabled ? "Active" : "Disabled"}
                    </button>
                    {canManage && (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" onClick={() => setEditing(u)} title="Edit">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setResettingPassword(u)} title="Reset password">
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setDeleting(u)} title="Delete">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* md+: table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    {["Name", "Username", "Email", "Phone", "Role", "Status", ...(canManage ? ["Actions"] : [])].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((u) => (
                    <tr key={u.id} className="hover:bg-muted/20">
                      <td className="px-3 py-2.5 font-medium">{u.fullName}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{u.username}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{u.email ?? "—"}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{u.phone ?? "—"}</td>
                      <td className="px-3 py-2.5"><RoleBadge role={u.role} /></td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => toggleEnabled(u)}
                          disabled={!canManage}
                          className={cn(
                            "rounded px-1.5 py-0.5 text-xs font-medium",
                            u.enabled ? "bg-brand-100 text-brand-700" : "bg-gray-100 text-gray-500",
                            !canManage && "cursor-default",
                          )}
                          title={canManage ? "Click to toggle" : undefined}
                        >
                          {u.enabled ? "Active" : "Disabled"}
                        </button>
                      </td>
                      {canManage && (
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <button onClick={() => setEditing(u)} className="text-muted-foreground hover:text-foreground" title="Edit">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setResettingPassword(u)} className="text-muted-foreground hover:text-foreground" title="Reset password">
                              <KeyRound className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setDeleting(u)} className="text-muted-foreground hover:text-destructive" title="Delete">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Card>
      </div>

      {createOpen && (
        <UserFormModal
          title="New user"
          onClose={() => setCreateOpen(false)}
          onSaved={(pw, username) => {
            setCreateOpen(false);
            if (pw) setReveal({ username, password: pw });
            load();
          }}
        />
      )}

      {editing && (
        <UserFormModal
          title="Edit user"
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete user"
          message={`Permanently delete ${deleting.fullName}'s account (${deleting.username})? This cannot be undone.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        />
      )}

      {resettingPassword && (
        <ConfirmModal
          title="Reset password"
          message={`Reset the password for ${resettingPassword.fullName} (${resettingPassword.username})? Their current password will stop working immediately, and a new temporary one will be shown once.`}
          confirmLabel="Reset password"
          onCancel={() => setResettingPassword(null)}
          onConfirm={confirmResetPassword}
        />
      )}

      {reveal && (
        <RevealPasswordModal reveal={reveal} onClose={() => setReveal(null)} />
      )}
    </div>
  );
}

function UserFormModal({
  title, user, onClose, onSaved,
}: {
  title: string;
  user?: StaffUser;
  onClose: () => void;
  onSaved: (temporaryPassword: string | null, username: string) => void;
}) {
  const isEdit = Boolean(user);
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [username, setUsername] = useState(user?.username ?? "");
  const [usernameTouched, setUsernameTouched] = useState(isEdit);
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [role, setRole] = useState<CrmRole>(user?.role ?? "crm-reception");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function deriveUsername(emailValue: string) {
    if (usernameTouched) return;
    setUsername(emailValue.split("@")[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, "") ?? "");
  }

  async function save() {
    const pErr = validateIndianPhone(phone);
    if (pErr) { setPhoneError(pErr); return; }
    setPhoneError(null);
    setSaving(true);
    setError(null);
    try {
      if (isEdit && user) {
        await api.patch(`/api/admin/users/${user.id}`, { firstName, lastName, email, role, phone });
        onSaved(null, user.username);
      } else {
        const result = await api.post<{ temporaryPassword: string }>("/api/admin/users", {
          firstName, lastName, email, username, role, phone,
        });
        onSaved(result.temporaryPassword, username);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={title} className="md:max-w-md">
        <div className="space-y-3 px-4 py-4 md:px-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="First name">
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </Field>
            <Field label="Last name">
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </Field>
          </div>
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); deriveUsername(e.target.value); }}
            />
          </Field>
          <Field label="Username">
            <Input
              value={username}
              disabled={isEdit}
              onChange={(e) => { setUsernameTouched(true); setUsername(e.target.value); }}
              placeholder="lowercase, no spaces"
            />
          </Field>
          <Field label="Phone">
            <Input
              value={phone}
              onChange={(e) => { setPhone(e.target.value); setPhoneError(validateIndianPhone(e.target.value)); }}
              placeholder="+919876543210"
              className={phoneError ? "border-destructive focus-visible:ring-destructive" : ""}
            />
            {phoneError ? (
              <p className="mt-1 text-xs text-destructive">{phoneError}</p>
            ) : (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Optional — needed for click-to-call and inbound call routing.
              </p>
            )}
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as CrmRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </Select>
          </Field>
          {!isEdit && (
            <p className="text-xs text-muted-foreground">
              A temporary password will be generated and shown once after creation — the new user must
              change it on first login.
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3.5 md:px-5">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            onClick={save}
            disabled={saving || !firstName || !lastName || !email || !username}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? "Save changes" : "Create user"}
          </Button>
        </div>
    </Dialog>
  );
}

function ConfirmModal({
  title, message, confirmLabel, destructive, onCancel, onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onClose={onCancel} title={title} className="md:max-w-sm">
      <div className="p-4 md:p-5">
        <p className="text-sm text-muted-foreground">{message}</p>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            disabled={busy}
            onClick={async () => {
              // A rejection used to leave `busy` stuck true — the button spun
              // forever with no message. Always reset and surface the error.
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Action failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RevealPasswordModal({
  reveal, onClose,
}: {
  reveal: { username: string; password: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const ok = await copyToClipboard(reveal.password);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Temporary password" className="md:max-w-sm">
      <div className="p-4 md:p-5">
        <p className="text-xs text-muted-foreground">
          Shown once — share it with <span className="font-medium text-foreground">{reveal.username}</span> now.
          They&apos;ll be required to set a new password on first login.
        </p>
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-2">
          <code className="flex-1 break-all text-sm text-foreground">{reveal.password}</code>
          <button onClick={copy} className="shrink-0 text-brand-600 hover:opacity-70">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
