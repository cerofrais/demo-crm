/**
 * Node.js-only startup: launch the in-process inbound-email poller when enabled.
 * Imported by instrumentation.ts behind a NEXT_RUNTIME === "nodejs" guard, so
 * the node-only mail libraries never reach the Edge bundle. Runs once per
 * server process (guarded against dev HMR double-invoke).
 */
import { pollInbound } from "@/lib/inbound-mail";
import { runAiPipeline } from "@/lib/ai/pipeline";
import { aiPipelineEnabled, aiPipelineIntervalSec } from "@/lib/ai/config";
import { runDeletionSweep } from "@/lib/lead-deletion";
import { tickBroadcast } from "@/lib/broadcast";
import { tickDailyMarketingReport } from "@/lib/marketing-report";
import { logger } from "@/lib/logger";

const g = globalThis as unknown as {
  __treInboundStarted?: boolean;
  __treAiPipelineStarted?: boolean;
  __treDeletionSweepStarted?: boolean;
  __treBroadcastStarted?: boolean;
  __treMarketingReportStarted?: boolean;
};

if (process.env.EMAIL_INBOUND_ENABLED === "true" && !g.__treInboundStarted) {
  g.__treInboundStarted = true;
  const intervalSec = Math.max(30, Number(process.env.EMAIL_POLL_INTERVAL_SEC ?? 120));
  logger.info({ intervalSec }, "inbound email poller starting");
  setTimeout(() => {
    void pollInbound();
    setInterval(() => void pollInbound(), intervalSec * 1000);
  }, 10_000);
}

if (aiPipelineEnabled() && !g.__treAiPipelineStarted) {
  g.__treAiPipelineStarted = true;
  const intervalSec = aiPipelineIntervalSec();
  logger.info({ intervalSec, provider: process.env.AI_PROVIDER ?? "ollama" }, "ai pipeline starting");
  setTimeout(() => {
    void runAiPipeline();
    setInterval(() => void runAiPipeline(), intervalSec * 1000);
  }, 20_000);
}

if (!g.__treDeletionSweepStarted) {
  g.__treDeletionSweepStarted = true;
  const intervalSec = 3600; // hourly — the day-count itself is admin-configurable, not this cadence
  logger.info({ intervalSec }, "dead-lead auto-delete sweep starting");
  setTimeout(() => {
    void runDeletionSweep();
    setInterval(() => void runDeletionSweep(), intervalSec * 1000);
  }, 30_000);
}

if (!g.__treBroadcastStarted) {
  g.__treBroadcastStarted = true;
  const intervalSec = 2; // sends at most 1 msg/tick — actual pacing is the job's own delaySec
  logger.info({ intervalSec }, "whatsapp broadcast worker starting");
  setTimeout(() => {
    void tickBroadcast();
    setInterval(() => void tickBroadcast(), intervalSec * 1000);
  }, 15_000);
}

if (!g.__treMarketingReportStarted) {
  g.__treMarketingReportStarted = true;
  // Ticked every 15 minutes; the tick itself does nothing until the configured
  // IST hour, and nothing at all once the day's report has been emailed. The
  // "already done" check is the MarketingReport row, not this timer, so a
  // restart or a second instance can't re-send to the CEO.
  const intervalSec = 900;
  logger.info({ intervalSec }, "daily marketing report scheduler starting");
  setTimeout(() => {
    void tickDailyMarketingReport();
    setInterval(() => void tickDailyMarketingReport(), intervalSec * 1000);
  }, 45_000);
}
