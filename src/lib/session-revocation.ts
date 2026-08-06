/**
 * DEMO BRANCH: real session-revocation (src/lib/session-revocation.ts on
 * main) fail-closes against Redis — exactly wrong here, since there's no
 * Redis and (app)/layout.tsx calls isSessionRevoked() on every page load.
 * Demo sessions are never admin-revoked, so this is a permanent no-op
 * rather than a real check.
 */
export type RevocationReason = "role_changed" | "disabled" | "deleted";
export type RevocationResult = RevocationReason | "revoked" | null;

export async function markRevoked(_sub: string, _reason: RevocationReason): Promise<void> {
  // no-op in demo mode
}

export async function isSessionRevoked(
  _sub: string,
  _sessionVersion: number | undefined,
): Promise<RevocationResult> {
  return null;
}
