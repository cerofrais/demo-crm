# 15 — AI/ML call map: what runs where

Every place the app makes an ML inference call, what triggers it, what data it
sends, and — the point of this doc — **whether that call stays on your own
infrastructure or leaves it.** All AI code lives in
[`src/lib/ai/`](../src/lib/ai); see [14 — AI features](./14-ai-features.md)
for the feature-level description and env vars.

## TL;DR — current live configuration

| Component | Where it runs | Reaches the internet? |
| --- | --- | --- |
| LLM (call scoring, coaching, lead ranking, assist drafts, transcript reconciliation/translation) | **Local** — Ollama on the deploy box, `gemma4:latest`, GPU | No |
| Call transcription | **Local** — `indic-asr` container (AI4Bharat IndicConformer, CPU) on the same box, once per language in `ASR_LANGUAGES` | No |
| Call recording *storage* | **Cloud** — Plivo (telephony provider) | Yes — Plivo's servers |
| Enquiry webhook / email / DB / storage | Local (Postgres, MinIO) or your SMTP provider | Depends on `EMAIL_PROVIDER` |

**As deployed today, zero guest data (health profiles, call audio, email
content, conversation history) is sent to any third-party AI API.** The one
external network call in the entire AI pipeline is fetching the *recorded
audio bytes* from Plivo (who already have them — they made the recording) so
they can be transcribed locally. Everything downstream — transcription,
reconciliation/translation, scoring, coaching, summaries, drafts — runs on
models hosted on your own server and never leaves it.

This is a **deliberate architecture choice, not a hard limit**: every AI
component is swappable to a cloud provider (OpenAI, Anthropic, etc.) via env
vars alone, with zero code changes — see [§4](#4-switching-to-a-cloud-provider).
Transcription switched from `whisper`/faster-whisper-small (frequent
hallucination on Telugu/code-switched audio) to `indic-asr`/AI4Bharat
IndicConformer on 2026-07-04 — see [§3](#3-live-asr-backend-ai4bharat-indicconformer)
for how the app works around IndicConformer's single-language-per-request
limitation: each call is transcribed once per candidate language (Telugu and
Hindi by default — reps use both), then the LLM reconciles the attempts into
one corrected native-script transcript **and** a fluent English translation,
both stored and both shown in the UI.

---

## 1. Every AI/ML call site

### 1.1 LLM calls (chat completions)

All five AI decisions funnel through one function:
[`chat()`](../src/lib/ai/provider.ts) / [`chatJSON()`](../src/lib/ai/provider.ts) in `src/lib/ai/provider.ts:30`
→ `POST {AI_BASE_URL}/chat/completions` (OpenAI wire format).

| Feature | File | Triggered by | Data sent to the LLM |
| --- | --- | --- | --- |
| Transcript reconciliation + English translation | `src/lib/ai/transcript-translate.ts` | Background pipeline tick, or `POST /api/calls/:id/analyze` (before scoring) | Every raw ASR attempt for the call, one per language in `ASR_LANGUAGES` |
| Call analysis (score, tags, coaching, summary) | `src/lib/ai/call-analysis.ts` | Background pipeline tick, or `POST /api/calls/:id/analyze` | The English-translated transcript (or rep's notes if no recording), call metadata (direction, duration, rep name, guest name, lead stage) |
| Lead conversion scoring | `src/lib/ai/lead-scoring.ts` | Background pipeline tick | Guest name/city/returning flag, stage, source, tags, quoted price, package, recent email subjects, recent call summaries, recent internal notes |
| Guest return-likelihood + next-programme insight | `src/lib/ai/guest-insights.ts` | Background pipeline tick | Guest name/city, stay/booking history, active memberships, **decrypted health profile** (conditions, medications, diet notes), tags |
| Conversation assist (summary, next actions, draft reply) | `src/lib/ai/assistant.ts` | `POST /api/ai/assist` (rep clicks "Generate" in the AI Assist tab) | Full lead context: profile, stage, package, notes, last 12 email messages (subject + body), last 5 call summaries, open tasks |

**Where this runs:** `AI_BASE_URL` on the deploy box is
`http://localhost:11434/v1` — Ollama, running as a host-level systemd service
(not a container), serving `gemma4:latest` on the GPU. Nothing here leaves
the box.

### 1.2 Audio transcription (once per candidate language)

[`transcribeAudio()`](../src/lib/ai/transcribe.ts) in `src/lib/ai/transcribe.ts:24`
→ `POST {AI_TRANSCRIBE_BASE_URL}/audio/transcriptions` (OpenAI wire format,
multipart file upload, with a `language` field). Called from
`src/lib/ai/call-analysis.ts` **once per entry in `ASR_LANGUAGES`** (default
`te,hi` — Telugu and Hindi, since reps use both), only when a call has a
recording and no English translation yet. All attempts are then reconciled
into one transcript + translation — see §1.1's first row.

**Where this runs:** `AI_TRANSCRIBE_BASE_URL` is currently
`http://indic-asr:8001/v1` — the `indic-asr` Docker service (AI4Bharat
IndicConformer, CPU), reachable only inside the compose network. The audio
file (already downloaded from Plivo — see §1.3) is forwarded to this
container over the internal Docker network, once per language; it never goes
back out to the internet.

### 1.3 Call recording fetch (the one real external call)

[`fetchRecording()`](../src/lib/plivo.ts) in `src/lib/plivo.ts:60` →
`GET <plivo-recording-url>` with HTTP Basic auth (`PLIVO_AUTH_ID`/`PLIVO_AUTH_TOKEN`).
Called from `src/lib/ai/call-analysis.ts` before transcription.

**Where this runs:** **Cloud.** Plivo is the VoIP provider that made the
recording in the first place (see [13 — VoIP calls](./13-voip-calls.md)) —
the audio physically lives on `aps1.media.plivo.com` until this fetch pulls
it down. This is not really an "AI" call, but it's the only network hop in
the whole pipeline that crosses your infrastructure boundary, so it's called
out explicitly here. Once fetched, the bytes are handed to the local
`indic-asr` container (once per candidate language) and are not re-uploaded
anywhere.

### 1.4 Decision audit logging (local, every call)

[`logAiDecision()`](../src/lib/ai/audit.ts) — writes one `AiDecision` row to
Postgres after every LLM call in §1.1 (both on success and on failure),
capturing the exact prompt sent, the exact output received, the model that
produced it, and who/what triggered it. Kinds: `transcript_translation`,
`call_analysis`, `lead_scoring`, `guest_insight`, `conversation_assist`. This
is a local database write, not a network call — see [14 — AI features
§"AI/ML decision audit trail"](./14-ai-features.md#aiml-decision-audit-trail)
for the full schema and the admin-only `/ai-decisions` page that surfaces it.
Because it captures the *exact* prompt (including any transcript/health/email
content embedded in it), the audit table itself should be treated with the
same sensitivity as the source data — it's local storage, but it is a second
place that data now lives.

### 1.5 The background pipeline (orchestration, no network calls of its own)

[`runAiPipeline()`](../src/lib/ai/pipeline.ts) in `src/lib/ai/pipeline.ts` —
started from `src/instrumentation-node.ts` on server boot (same pattern as
the inbound-email poller), runs every `AI_PIPELINE_INTERVAL_SEC` (default
300s). Each tick calls, in order: `runCallAnalysis()` (≤5 calls) →
`runLeadScoring()` (≤8 leads) → `runGuestInsights()` (≤5 guests) — each of
which makes the LLM/transcription calls described in §1.1/§1.2. Guarded
against overlapping runs. `POST /api/ai/pipeline` (admin/manager only) forces
an immediate tick.

---

## 2. Data flow diagram (call analysis, the most involved path)

```
Guest's phone call
     │
     ▼
Plivo (CLOUD) — routes call, records it, stores the .mp3
     │  recordingUrl saved to Call.recordingUrl (Postgres, local)
     ▼
App fetches the recording  ──────────────►  Plivo (CLOUD)
     │  (GET with Basic auth — src/lib/plivo.ts:60)
     ▼
Audio bytes held in the app's memory (Node.js process, local)
     │
     ├──► POST /v1/audio/transcriptions (language=te) ──►  indic-asr (LOCAL, same host)
     └──► POST /v1/audio/transcriptions (language=hi) ──►  indic-asr (LOCAL, same host)
     │  one raw attempt per ASR_LANGUAGES entry
     ▼
POST /v1/chat/completions  ───────────────►  Ollama / gemma4 (LOCAL, same host, GPU)
     │  reconciles attempts → native transcript + English translation
     │  logged as AiDecision (kind: transcript_translation)
     ▼
Saved to Call.transcript / transcriptEnglish / transcriptLanguage (Postgres, local)
     │
     ▼
POST /v1/chat/completions  ───────────────►  Ollama / gemma4 (LOCAL, same host, GPU)
     │  score/tags/coaching/summary returned, from the English translation
     │  logged as AiDecision (kind: call_analysis)
     ▼
Saved to Call.aiScore / aiTags / aiSuggestions / aiSummary (Postgres, local)
     │
     ▼
Rendered in the Calls tab / /calls page (browser, over your own app's HTTPS) —
both the English translation and the original native transcript
```

Lead scoring, guest insights, and conversation assist follow the same shape
minus the Plivo/transcription hop — they read directly from Postgres and go
straight to the local LLM.

---

## 3. Live ASR backend: AI4Bharat IndicConformer

`infra/indic-asr/` wraps [AI4Bharat's IndicConformer](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual)
(MIT-licensed, self-hosted, all 22 official Indian languages) behind the same
OpenAI-compatible shape `whisper` used. **This is the active transcription
backend as of 2026-07-04** (`AI_TRANSCRIBE_BASE_URL=http://indic-asr:8001/v1`),
replacing `whisper`/faster-whisper-small, which hallucinated badly on
Telugu/code-switched call audio (repeating a single token instead of
transcribing). `whisper` is still deployed and can be switched back to with
one env change if needed.

**Known limitation, addressed with a reconciliation step.** Each request to
the model takes a single hard language code and has no English mode and no
per-word language detection — a raw attempt decoded as `te` renders English
words as phonetic transliteration rather than literal English text (e.g.
"test" becomes `టెస్ట్`). Since reps sometimes speak Hindi too, the app now
transcribes each call once per language in `ASR_LANGUAGES` (default `te,hi`)
and has the LLM reconcile the attempts into one corrected native-script
transcript **plus a fluent English translation** — both stored on the `Call`
row and both audited as an `AiDecision` (kind `transcript_translation`). The
English translation is what feeds the scoring/coaching step. See
[14 — AI features](./14-ai-features.md#live-ai4bharat-indicconformer-indian-regional-languages)
for the full flow, and for the alternative (a larger Whisper model with
native multilingual code-switch detection) if this LLM-reconciled approach
isn't accurate enough in practice.

One thing worth knowing: getting the model weights onto the box required a
**one-time** authenticated download from Hugging Face (gated repo, needs
`HF_TOKEN` + an approved access request). That download is a build/first-run
step, not a per-call runtime dependency — once the weights are cached in the
`indicasrmodels` volume, `indic-asr` runs fully offline like `whisper` does.

---

## 4. Switching to a cloud provider

Nothing above is hard-wired to "local." Every AI component reads its target
from env vars and speaks the same OpenAI wire format, so pointing any piece
at a cloud provider is a config change, not a code change:

| To use... | Change |
| --- | --- |
| OpenAI (LLM) | `AI_BASE_URL=https://api.openai.com/v1`, `AI_API_KEY=sk-...`, `AI_MODEL=gpt-4o` (or similar) |
| Anthropic (LLM) | `AI_BASE_URL=https://api.anthropic.com/v1`, `AI_API_KEY=sk-ant-...`, `AI_MODEL=claude-...` |
| OpenAI Whisper (transcription) | `AI_TRANSCRIBE_BASE_URL=https://api.openai.com/v1`, `AI_TRANSCRIBE_API_KEY=sk-...`, `AI_TRANSCRIBE_MODEL=whisper-1` |

**The moment any of these point at a cloud endpoint, the data described in
§1.1's "data sent" column — including decrypted health profile content,
call transcripts, and email bodies — leaves your infrastructure and goes to
that provider.** That's a real decision with compliance implications (DPDP,
and HIPAA-adjacent given the health data involved) — see the new AI/ML
section in [11 — Production release checklist](./11-production-release-checklist.md#12-aiml-production-readiness)
before flipping any of these switches for real guest data.

---

## 5. Non-AI cloud dependencies in the same neighborhood

Not machine learning, but worth knowing about since they sit right next to
the AI pipeline in the data flow:

- **Plivo** — VoIP routing + call recording storage (§1.3 above). Also
  receives outbound-call requests and inbound-call webhooks (see
  [13 — VoIP calls](./13-voip-calls.md)).
- **Gmail SMTP/IMAP** (or whatever `EMAIL_PROVIDER` is set to) — email bodies
  that later get fed to the LLM (as conversation-assist context, or the
  auto-tagged `needsAttention` flag) pass through this provider on the way
  in/out. See [12 — Email integration](./12-email-integration.md).
- **Hugging Face** — one-time gated model download for `indic-asr` (§3), not
  a runtime dependency once cached.
