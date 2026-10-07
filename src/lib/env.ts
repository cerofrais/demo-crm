import { z } from "zod";

/**
 * Centralised, typed access to environment variables.
 * Defaults keep `next build` from failing when a full .env is absent; at
 * runtime the real values come from .env / docker-compose. Treat missing
 * production secrets as a deploy-time concern (see docs/08-env-vars.md).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().default("Meridian Wellness CRM"),
  APP_URL: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  DATABASE_URL: z.string().default("postgresql://localhost:5432/tre_crm"),
  DIRECT_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  KEYCLOAK_URL: z.string().default("http://localhost:8080"),
  KEYCLOAK_PUBLIC_URL: z.string().optional(),
  KEYCLOAK_REALM: z.string().default("tre-wellness"),
  KEYCLOAK_CLIENT_ID: z.string().default("tre-crm"),
  KEYCLOAK_CLIENT_SECRET: z.string().default("change-me-keycloak-client-secret"),

  NEXTAUTH_URL: z.string().default("http://localhost:3000"),
  NEXTAUTH_SECRET: z.string().default("dev-insecure-secret-change-me"),

  HEALTH_ENCRYPTION_KEY: z.string().optional(),

  STORAGE_ENDPOINT: z.string().default("http://localhost:9000"),
  STORAGE_PUBLIC_ENDPOINT: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().default("tre-minio"),
  STORAGE_SECRET_KEY: z.string().default("change-me-minio-secret"),
  STORAGE_BUCKET: z.string().default("tre-crm-files"),

  EMAIL_PROVIDER: z.enum(["smtp", "resend"]).default("smtp"),
  EMAIL_FROM: z.string().default("Trē Wellness <hello@trewellness.in>"),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),

  // Meta lead-ads / enquiry-form webhook verification handshake — see
  // /api/webhooks/enquiry-form. Distinct from WA_BUSINESS_TOKEN_WEBHOOK below.
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  // Meta WhatsApp Cloud API webhook (POST /api/webhooks/whatsapp-cloud).
  //
  // WA_BUSINESS_TOKEN_WEBHOOK is the "Verify Token" registered in the Meta
  // app dashboard; Meta echoes it back on the GET subscription handshake.
  // Name kept as-is because it is already set in .env — it used to belong to
  // the evolution-api container, which handled this handshake back when Cloud
  // API traffic was relayed through it.
  //
  // META_APP_SECRET is the Meta app's App Secret, used to verify the
  // X-Hub-Signature-256 on every webhook POST. Optional so a deploy can't be
  // taken down by a missing value, but the route logs a warning on every
  // unverified request while it is unset: this endpoint creates leads and
  // updates delivery statuses from its payload, so anyone who learns the URL
  // can forge both until it is set.
  WA_BUSINESS_TOKEN_WEBHOOK: z.string().optional(),
  META_APP_SECRET: z.string().optional(),

  // Evolution API (self-hosted WhatsApp gateway, Baileys-based) — see
  // docs/17-whatsapp-integration.md. EVOLUTION_API_KEY is the GLOBAL admin
  // key, shared with the evolution-api container's own AUTHENTICATION_API_KEY.
  EVOLUTION_API_URL: z.string().default("http://localhost:8090"),
  EVOLUTION_API_KEY: z.string().default("change-me-evolution-api-key"),
  // Query-param shared secret Evolution appends to its webhook calls to us —
  // verified in POST /api/webhooks/whatsapp before trusting the payload.
  WHATSAPP_WEBHOOK_SECRET: z.string().default("change-me-whatsapp-webhook-secret"),

  ENQUIRY_WEBHOOK_SECRET: z.string().default("change-me-enquiry-webhook-secret"),

  RATE_LIMIT_AUTHED_PER_MIN: z.coerce.number().default(200),
  RATE_LIMIT_ANON_PER_MIN: z.coerce.number().default(20),
  AUTO_ASSIGN_STRATEGY: z.enum(["round_robin", "unassigned"]).default("round_robin"),
});

// DEMO BRANCH: main's guardedSchema refuses committed-default secrets at
// production runtime — exactly wrong here, since this deploys to Vercel with
// NODE_ENV=production and intentionally never touches a real DB/Redis/
// Keycloak/SMTP/S3 (see src/lib/demo/*). No production guard needed.
const guardedSchema = schema;

function parseEnv() {
  const result = guardedSchema.safeParse(process.env);
  if (result.success) return result.data;
  // Surface a clear, readable startup error instead of letting the raw
  // ZodError escape. ZodError.message is a getter-only accessor with no
  // setter, and Next's own instrumentation-hook loader (next-server.js
  // prepareImpl) tries to prefix .message on whatever it catches —
  // crashing with a cryptic "Cannot set property message of [object
  // Object] which has only a getter" TypeError that discards the actual
  // validation failures entirely and crash-loops the server on every
  // request. A plain Error has a normal writable .message, so that
  // prefixing works fine and the real problem is what gets logged.
  const details = result.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parseEnv();

/** Browser-facing issuer — the `iss` claim Keycloak actually puts in tokens
 *  (derived from whatever host the browser used, KC_HOSTNAME_STRICT=false),
 *  and where the browser gets redirected for the authorization step. */
export const keycloakIssuer = `${
  env.KEYCLOAK_PUBLIC_URL ?? env.KEYCLOAK_URL
}/realms/${env.KEYCLOAK_REALM}`;

/**
 * Server-reachable issuer — used for the token/userinfo/jwks calls the app
 * container itself makes (the code exchange, refreshing, etc). Deliberately
 * separate from `keycloakIssuer`: KEYCLOAK_PUBLIC_URL only has to be
 * reachable from a BROWSER, not from inside this container, and in
 * deployments where it's a Tailscale/VPN-only hostname the container
 * genuinely cannot route to it at all (no such constraint applies to
 * KEYCLOAK_URL, always an address this container itself can reach — the
 * in-compose service name, or the same localhost host-dev shares with the
 * browser). See auth.ts's KeycloakProvider — wellKnown discovery is
 * disabled specifically so it never tries to fetch from `keycloakIssuer`
 * server-side.
 */
export const keycloakInternalIssuer = `${env.KEYCLOAK_URL}/realms/${env.KEYCLOAK_REALM}`;

/**
 * Whether session cookies get the Secure flag + `__Secure-` name prefix.
 * F34: pinned to NODE_ENV/ALLOW_INSECURE_PROD_CONFIG rather than inferred
 * from NEXTAUTH_URL's scheme, so a misconfigured URL can never silently
 * downgrade prod cookies to non-Secure.
 *
 * The single source of truth for BOTH auth.ts's `useSecureCookies` (decides
 * what the sign-in callback actually names/flags the cookie) and
 * middleware.ts's explicit `cookies.sessionToken.name` override. Without
 * that second wiring, next-auth's own `getToken()` (which middleware.ts's
 * withAuth calls to read the cookie back) independently re-derives
 * secureCookie from NEXTAUTH_URL's scheme instead of asking authOptions —
 * on an https NEXTAUTH_URL it would look for `__Secure-next-auth.session-token`
 * even though ALLOW_INSECURE_PROD_CONFIG=true made the callback set the
 * plain, unprefixed name. Every request then reads back token=null despite
 * a valid session cookie sitting right there, which middleware treats as
 * "not signed in" and bounces to /login — indistinguishable from an actual
 * auth failure without tracing the raw Set-Cookie/getToken lookup, which is
 * how this one shipped in the first place.
 */
export const useSecureCookies =
  process.env.NODE_ENV === "production" && process.env.ALLOW_INSECURE_PROD_CONFIG !== "true";
