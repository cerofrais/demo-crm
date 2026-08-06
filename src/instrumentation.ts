/**
 * Next.js boot hook. Node-only work (the inbound-email IMAP poller, which pulls
 * `imapflow`/`stream`) lives in a separate module imported ONLY in the Node.js
 * runtime, so it's never compiled into the Edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
