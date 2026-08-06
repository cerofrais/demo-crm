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
  if (language) form.append("language", language);

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
