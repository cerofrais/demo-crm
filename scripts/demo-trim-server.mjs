/**
 * Demo build only — strips the server surface this build can never use.
 *
 * Nothing reaches a backend here: every /api/** call is answered in the
 * browser by src/lib/demo/* (see interceptor.ts), and the two paths that are
 * fetched as binaries rather than JSON — a document and a call recording —
 * are served by middleware.ts. The 147 route handlers under src/app/api are
 * therefore dead weight that Vercel still has to package as a serverless
 * function each, and src/instrumentation.ts boots an IMAP poller against a
 * mailbox that does not exist.
 *
 * They are moved rather than deleted, and only when running on Vercel, so the
 * files stay tracked — main keeps changing them and the demo branch has to
 * keep merging cleanly — and a local `npm run build` leaves the tree alone.
 */
import { rm } from "node:fs/promises";

if (!process.env.VERCEL) {
  console.log("demo-trim-server: not on Vercel, leaving the tree alone");
  process.exit(0);
}

for (const path of ["src/app/api", "src/instrumentation.ts", "src/instrumentation-node.ts"]) {
  await rm(path, { recursive: true, force: true });
  console.log(`demo-trim-server: removed ${path} from this build`);
}
