/**
 * AI provider configuration — everything comes from env so the stack can be
 * pointed at any OpenAI-compatible chat endpoint without a code change:
 *
 *   • Ollama (default local):  AI_BASE_URL=http://localhost:11434/v1
 *   • OpenAI:                  AI_BASE_URL=https://api.openai.com/v1
 *   • Anthropic (compat):      AI_BASE_URL=https://api.anthropic.com/v1
 *   • vLLM / LM Studio / OpenRouter — any /v1 chat-completions server.
 *
 * Transcription uses the same OpenAI shape (`/audio/transcriptions`) so a
 * local faster-whisper server or OpenAI Whisper both work. Leaving
 * AI_TRANSCRIBE_BASE_URL empty disables audio transcription; call analysis
 * then falls back to the rep's call notes.
 */

export interface TranscribeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiConfig {
  provider: string; // informational label: ollama | openai | anthropic | …
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export function aiEnabled(): boolean {
  return process.env.AI_ENABLED === "true";
}

export function aiConfig(): AiConfig {
  return {
    provider: process.env.AI_PROVIDER ?? "ollama",
    baseUrl: (process.env.AI_BASE_URL ?? "http://localhost:11434/v1").replace(/\/$/, ""),
    // Ollama ignores the key but the OpenAI wire format requires the header.
    apiKey: process.env.AI_API_KEY ?? "ollama",
    model: process.env.AI_MODEL ?? "llama3.1",
    temperature: Number(process.env.AI_TEMPERATURE ?? 0.2),
    maxTokens: Number(process.env.AI_MAX_TOKENS ?? 1024),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 120_000),
  };
}

export function transcribeConfig(): TranscribeConfig | null {
  const baseUrl = process.env.AI_TRANSCRIBE_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: process.env.AI_TRANSCRIBE_API_KEY ?? process.env.AI_API_KEY ?? "ollama",
    model: process.env.AI_TRANSCRIBE_MODEL ?? "whisper-1",
  };
}

/**
 * Candidate languages to transcribe each call in. Each entry costs one full
 * decode of the recording; the LLM then reconciles the attempts and translates
 * to English — see src/lib/ai/transcript-translate.ts.
 *
 * `undefined` means "send no language and let the backend auto-detect", which
 * is the default and the right setting for Whisper: it detects language itself
 * and handles code-switched Indian English (the bulk of these calls) in a
 * single pass. Measured on production recordings, pinning `en` produced
 * byte-identical output to auto-detect, while forcing a wrong language is what
 * drives Whisper into repetition loops — so auto is both cheaper and safer.
 *
 * Set ASR_LANGUAGES only for a backend that cannot auto-detect (e.g.
 * IndicConformer, which has no auto mode and no English support at all).
 */
export function asrLanguages(): (string | undefined)[] {
  const raw = process.env.ASR_LANGUAGES?.trim();
  if (!raw) return [undefined]; // one pass, backend auto-detects
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export type AiFeature = "callAnalysis" | "leadScoring" | "guestInsights" | "assist";

const FEATURE_ENV: Record<AiFeature, string> = {
  callAnalysis: "AI_FEATURE_CALL_ANALYSIS",
  leadScoring: "AI_FEATURE_LEAD_SCORING",
  guestInsights: "AI_FEATURE_GUEST_INSIGHTS",
  assist: "AI_FEATURE_ASSIST",
};

/**
 * Per-feature kill switches for incremental rollout. Default ON — set the
 * env var to "false" to disable a single feature without touching the rest.
 */
export function aiFeatureEnabled(feature: AiFeature): boolean {
  return aiEnabled() && process.env[FEATURE_ENV[feature]] !== "false";
}

export function aiPipelineEnabled(): boolean {
  return aiEnabled() && process.env.AI_PIPELINE_ENABLED !== "false";
}

/**
 * F17 — PHI egress gate. The configured chat endpoint is "loopback" (safe to
 * send raw PHI to) only when it resolves to the local host. Anything else
 * (api.openai.com, OpenRouter, a LAN box) is treated as external.
 */
export function isLoopbackAiBaseUrl(): boolean {
  try {
    const host = new URL(aiConfig().baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".localhost")
    );
  } catch {
    // Unparseable base URL — fail closed (treat as external).
    return false;
  }
}

/**
 * Whether the operator has explicitly opted in to sending guest health data to
 * a non-loopback AI endpoint. Default false: guest-insights refuses to run
 * against an external endpoint unless this is set, and even then only sends
 * coarse-redacted health flags (never raw diagnoses/medications).
 */
export function aiAllowExternalHealth(): boolean {
  return process.env.AI_ALLOW_EXTERNAL_HEALTH === "true";
}

export function aiPipelineIntervalSec(): number {
  return Math.max(60, Number(process.env.AI_PIPELINE_INTERVAL_SEC ?? 300));
}
