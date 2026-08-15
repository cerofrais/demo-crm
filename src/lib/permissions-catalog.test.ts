import { describe, expect, it } from "vitest";
import { ALL_ROLES, permissionsFor, type Permission } from "./rbac";
import { PERMISSION_CATALOG, PERMISSION_GROUP_ORDER, permissionMeta } from "./permissions-catalog";

/** Every permission actually granted to some role, i.e. what the app really uses. */
const grantedSomewhere = new Set<Permission>(ALL_ROLES.flatMap((r) => permissionsFor(r)));

describe("permission catalogue stays in sync with rbac", () => {
  it("documents every permission that any role is granted", () => {
    const documented = new Set(PERMISSION_CATALOG.map((p) => p.key));
    const undocumented = [...grantedSomewhere].filter((p) => !documented.has(p));
    // A new permission added to rbac.ts without a description would render on
    // the Permissions page as a bare key with "no description recorded".
    expect(undocumented).toEqual([]);
  });

  it("does not document permissions that no role holds", () => {
    const stale = PERMISSION_CATALOG.filter((p) => !grantedSomewhere.has(p.key)).map((p) => p.key);
    expect(stale).toEqual([]);
  });

  it("has no duplicate entries", () => {
    const keys = PERMISSION_CATALOG.map((p) => p.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("only uses groups that the page knows how to order", () => {
    for (const p of PERMISSION_CATALOG) {
      expect(PERMISSION_GROUP_ORDER).toContain(p.group);
    }
  });

  it("flags the destructive and privacy-sensitive ones", () => {
    const sensitive = new Set(PERMISSION_CATALOG.filter((p) => p.sensitive).map((p) => p.key));
    for (const key of ["leads.delete", "guests.delete", "health.view", "users.manage", "ai.audit"] as const) {
      expect(sensitive.has(key)).toBe(true);
    }
  });
});

describe("permissionMeta", () => {
  it("returns the documented entry", () => {
    expect(permissionMeta("leads.delete").label).toBe("Delete leads");
  });

  it("falls back rather than throwing on an unknown key", () => {
    // Guards the page against a permission added to rbac but not here.
    const meta = permissionMeta("not.a.real.permission" as Permission);
    expect(meta.label).toBe("not.a.real.permission");
    expect(meta.description).toContain("No description");
  });
});

describe("role matrix sanity", () => {
  it("gives ADMIN every sensitive capability", () => {
    const admin = permissionsFor("ADMIN");
    for (const key of ["leads.delete", "guests.delete", "users.manage", "ai.audit"] as const) {
      expect(admin).toContain(key);
    }
  });

  it("keeps VIEWER read-only — no send, delete or manage permissions", () => {
    for (const p of permissionsFor("VIEWER")) {
      expect(p).not.toMatch(/\.(delete|manage|send)$/);
    }
  });

  it("lists every role exactly once", () => {
    expect(ALL_ROLES.length).toBe(new Set(ALL_ROLES).size);
  });
});
