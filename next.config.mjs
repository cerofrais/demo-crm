/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone", // smaller Docker image
  poweredByHeader: false,
  // enables src/instrumentation.ts (inbound-email poller boot hook) on Next 14,
  // and keeps the mail libs as real runtime deps (not bundled) on the server.
  experimental: {
    instrumentationHook: true,
    // pino/pino-pretty spawn a worker thread (thread-stream); bundling them
    // breaks worker-module resolution under `next dev` (the transport worker
    // 500s the server). Keep them external so they load from node_modules.
    serverComponentsExternalPackages: [
      "imapflow",
      "mailparser",
      "nodemailer",
      "pino",
      "pino-pretty",
      "thread-stream",
    ],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "trewellness.in" },
    ],
  },
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    // Minimal security headers; CSP can be tightened per the tech spec §9.2
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Lock down powerful features we never use — except microphone,
          // needed for in-browser voice-note recording (WhatsApp panel +
          // remarks composer, see AudioRecordButton). A blanket microphone=()
          // here overrides any per-site mic permission the browser grants —
          // no user-facing "allow microphone" setting can undo a
          // server-sent policy that disables it for the whole origin, so
          // the record button would 403 with NotAllowedError unconditionally
          // regardless of what the user does in the browser's own UI.
          // (self) still blocks any third-party iframe from using it.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(), interest-cohort=()",
          },
          // HSTS with preload — once any https visit is seen, the browser forces
          // https thereafter, closing the cleartext-first-request MITM window.
          // Prod only, so local http dev is unaffected.
          ...(isProd
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=31536000; includeSubDomains; preload",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
