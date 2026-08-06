"use client";

import { SessionProvider } from "@/lib/demo/session-client";
import { IncomingCallBanner } from "@/components/calls/incoming-call-banner";
import { installDemoFetchInterceptor } from "@/lib/demo/interceptor";

// Installed at module scope (evaluated once when the client bundle loads,
// before React renders anything) so every component's fetch — even one
// fired from a useEffect on first mount — is already being intercepted.
// DEMO BRANCH: there's no real backend behind this deployment; see
// src/lib/demo/interceptor.ts.
installDemoFetchInterceptor();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <IncomingCallBanner />
      {children}
    </SessionProvider>
  );
}
