/**
 * Minimal OpenAI-compatible chat client (native fetch, no SDK).
 * Works against Ollama's /v1 endpoint, OpenAI, Anthropic's compat layer,
 * vLLM, LM Studio — anything that speaks POST {baseUrl}/chat/completions.
 */
import { aiConfig, aiEnabled } from "./config";
import { logger } from "@/lib/logger";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class AiDisabledError extends Error {
  constructor() {
    super("AI is not enabled (set AI_ENABLED=true)");
  }
}

export async function chat(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; json?: boolean },
): Promise<string> {
  if (!aiEnabled()) throw new AiDisabledError();
  const cfg = aiConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts?.temperature ?? cfg.temperature,
        max_tokens: opts?.maxTokens ?? cfg.maxTokens,
        // Ollama ≥0.5 and OpenAI both honour this; servers that don't simply
        // ignore unknown fields — the prompt still demands JSON.
        ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI chat ${res.status} (${cfg.provider}/${cfg.model}): ${text.slice(0, 400)}`);
    }
    const data = await res.json();
    const message = data?.choices?.[0]?.message;
    let content: string | undefined = message?.content;
    // Thinking models (e.g. gemma/deepseek-r1 builds on Ollama) stream their
    // chain-of-thought into `reasoning`; if the token budget runs out before
    // the final answer, `content` is empty — the JSON often still sits at the
    // end of the reasoning text, so fall back to it.
    if (!content?.trim() && typeof message?.reasoning === "string") {
      content = message.reasoning;
    }
    if (!content?.trim()) {
      const finish = data?.choices?.[0]?.finish_reason;
      throw new Error(`AI chat returned an empty response (finish_reason=${finish}) — for thinking models raise AI_MAX_TOKENS`);
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the first JSON object from a model response. Local models love to
 * wrap JSON in ```json fences or add commentary; strip all of that.
 */
export function extractJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`AI response contained no JSON object: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

/** Ask for structured output and parse it, with one retry on malformed JSON. */
export async function chatJSON<T>(
  system: string,
  user: string,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<T> {
  const messages: ChatMessage[] = [
    { role: "system", content: `${system}\n\nRespond with a single valid JSON object and nothing else.` },
    { role: "user", content: user },
  ];
  const first = await chat(messages, { ...opts, json: true });
  try {
    return extractJson<T>(first);
  } catch (err) {
    logger.warn({ err }, "ai chatJSON parse failed — retrying once");
    const retry = await chat(
      [
        ...messages,
        { role: "assistant", content: first },
        { role: "user", content: "That was not valid JSON. Reply again with ONLY the JSON object." },
      ],
      { ...opts, json: true },
    );
    return extractJson<T>(retry);
  }
}
