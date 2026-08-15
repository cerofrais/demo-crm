/**
 * Audio transcription via the OpenAI-compatible `/audio/transcriptions`
 * endpoint (multipart). Works with OpenAI Whisper, faster-whisper-server,
 * LocalAI, speaches, etc. Disabled when AI_TRANSCRIBE_BASE_URL is unset.
 */
import { transcribeConfig } from "./config";

export function transcriptionEnabled(): boolean {
  return transcribeConfig() !== null;
}

export async function transcribeAudio(
  audio: ArrayBuffer,
  filename = "recording.mp3",
  language?: string,
): Promise<string> {
  const cfg = transcribeConfig();
  if (!cfg) throw new Error("Transcription is not configured (AI_TRANSCRIBE_BASE_URL)");

  const form = new FormData();
  form.append("file", new Blob([audio]), filename);
  form.append("model", cfg.model);
  form.append("response_format", "json");
  // Omitted entirely when undefined so an auto-detecting backend (Whisper)
  // picks the language itself — forcing the wrong one is what sends it into
  // repetition loops on narrowband telephony audio.
  if (language) form.append("language", language);
  // Greedy decoding: deterministic, and avoids sampling into a loop.
  form.append("temperature", "0");
  // Silence stripping. Off by default in faster-whisper-server, and long silent
  // stretches are a repetition-loop trigger — but it also perturbs language
  // auto-detection, so it stays opt-in rather than on by default.
  if (process.env.ASR_VAD_FILTER === "true") form.append("vad_filter", "true");

  const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Transcription failed ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  if (typeof data?.text !== "string") throw new Error("Transcription returned no text");
  return data.text.trim();
}
