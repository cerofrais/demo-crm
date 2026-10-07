/**
 * Background AI pipeline — non-realtime. Each tick runs four batch steps:
 *   1. call analysis (transcribe + score/tag/coach recorded calls)
 *   2. voice notes (transcribe WhatsApp voice notes)
 *   3. lead conversion scoring (open enquiries with new activity)
 *   4. guest insights (return likelihood + next-programme + outreach tasks)
 * Guarded against overlapping runs, mirrors the inbound-mail poller pattern.
 */
import { logger } from "@/lib/logger";
import { aiEnabled, aiFeatureEnabled } from "./config";
import { runCallAnalysis } from "./call-analysis";
import { runVoiceNoteTranscription } from "./voice-note-transcribe";
import { runLeadScoring } from "./lead-scoring";
import { runGuestInsights } from "./guest-insights";

let running = false;

export interface PipelineRunSummary {
  callsAnalyzed: number;
  voiceNotesTranscribed: number;
  leadsScored: number;
  guestInsights: number;
}

export async function runAiPipeline(): Promise<PipelineRunSummary> {
  const summary: PipelineRunSummary = {
    callsAnalyzed: 0,
    voiceNotesTranscribed: 0,
    leadsScored: 0,
    guestInsights: 0,
  };
  if (!aiEnabled() || running) return summary;
  running = true;
  try {
    if (aiFeatureEnabled("callAnalysis")) {
      summary.callsAnalyzed = await runCallAnalysis().catch((err) => {
        logger.error({ err }, "ai pipeline: call analysis step failed");
        return 0;
      });
    }
    if (aiFeatureEnabled("voiceNotes")) {
      summary.voiceNotesTranscribed = await runVoiceNoteTranscription().catch((err) => {
        logger.error({ err }, "ai pipeline: voice note step failed");
        return 0;
      });
    }
    if (aiFeatureEnabled("leadScoring")) {
      summary.leadsScored = await runLeadScoring().catch((err) => {
        logger.error({ err }, "ai pipeline: lead scoring step failed");
        return 0;
      });
    }
    if (aiFeatureEnabled("guestInsights")) {
      summary.guestInsights = await runGuestInsights().catch((err) => {
        logger.error({ err }, "ai pipeline: guest insights step failed");
        return 0;
      });
    }
    if (
      summary.callsAnalyzed ||
      summary.voiceNotesTranscribed ||
      summary.leadsScored ||
      summary.guestInsights
    ) {
      logger.info(summary, "ai pipeline tick complete");
    }
  } finally {
    running = false;
  }
  return summary;
}
