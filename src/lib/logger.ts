import pino from "pino";
import { env } from "./env";

/**
 * Structured JSON logging via pino. In dev it pretty-prints; in prod it emits
 * JSON to stdout (collected by Docker / the platform). Every API error should
 * be logged with a correlationId (see lib/api.ts).
 */
const baseOptions = {
  level: env.LOG_LEVEL,
  base: { app: "tre-crm" },
  redact: {
    // never log secrets or PII tokens
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.token",
      "*.accessToken",
      "*.HEALTH_ENCRYPTION_KEY",
      // F25 (DPDP PII) defence-in-depth: scrub personal / call-metadata fields
      // if they ever slip into a log object. From/To/RecordUrl are Plivo fields.
      "*.email",
      "*.phone",
      "*.From",
      "*.To",
      "*.RecordUrl",
      "*.recordingUrl", // camelCase key used on our Call model / route logs
    ],
    remove: true,
  },
};

function createLogger() {
  if (env.NODE_ENV !== "development") return pino(baseOptions);
  try {
    // pino-pretty is a devDependency, not installed in the production image
    // — an internal deployment can still end up with NODE_ENV=development
    // there (see docs/08-env-vars.md), running that same production build.
    // pino's transport loader throws synchronously when the target module
    // isn't resolvable; that must never take down server startup, so it's
    // wrapped here instead of left to crash the whole instrumentation hook.
    return pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[logger] pino-pretty unavailable, falling back to plain JSON logs:",
      err instanceof Error ? err.message : err,
    );
    return pino(baseOptions);
  }
}

export const logger = createLogger();
