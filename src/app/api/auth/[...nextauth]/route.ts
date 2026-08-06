import { NextResponse } from "next/server";

/**
 * DEMO BRANCH: no real NextAuth/Keycloak flow — sign-in happens client-side
 * via the role picker (src/app/login/login-button.tsx), which never calls
 * any of these NextAuth endpoints. Kept as a harmless 404 rather than
 * deleted, in case anything still links here.
 */
export async function GET() {
  return NextResponse.json({ error: "Not used in demo mode" }, { status: 404 });
}
export const POST = GET;
