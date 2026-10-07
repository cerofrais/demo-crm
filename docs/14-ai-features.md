# 14 — AI features

Everything AI lives in [`src/lib/ai/`](../src/lib/ai) and is driven purely by
env vars. The provider layer speaks the **OpenAI chat-completions wire format**,
so any compatible server works — switch providers without touching code.

## Provider configuration

```bash
AI_ENABLED=true
AI_PROVIDER=ollama                        # informational label
AI_BASE_URL=http://localhost:11434/v1     # any OpenAI-compatible /v1 root
AI_API_KEY=ollama                         # ignored by Ollama, required by wire format
AI_MODEL=gemma4:latest
AI_TEMPERATURE=0.2
AI_MAX_TOKENS=2048
AI_TIMEOUT_MS=120000
```

| Provider | AI_BASE_URL | AI_API_KEY |
| --- | --- | --- |
| Ollama (host dev) | `http://localhost:11434/v1` | anything |
| Ollama (from compose) | `http://host.docker.internal:11434/v1` (set automatically in compose) | anything |
| OpenAI | `https://api.openai.com/v1` | `sk-…` |
| Anthropic (compat) | `https://api.anthropic.com/v1` | `sk-ant-…` |
| vLLM / LM Studio / OpenRouter | their `/v1` root | per provider |

**Thinking models** (e.g. the gemma4 build on the deploy box) put their
chain-of-thought in a separate `reasoning` field and need token headroom —
keep `AI_MAX_TOKENS` at 2048+. The client falls back to the reasoning text
when `content` comes back empty and strips ```json fences before parsing.

### Docker/firewall note

Compose adds `host.docker.internal:host-gateway` so containers can reach a
host-run Ollama. On Ubuntu with ufw you must also allow the Docker subnet:

```bash
sudo ufw allow from 172.18.0.0/16 to any port 11434 proto tcp
```

Ollama itself must listen on `0.0.0.0` (`OLLAMA_HOST=0.0.0.0:11434`).

## Features

All are **off** unless `AI_ENABLED=true`; each also has its own kill switch
(default on) for incremental rollout:

```bash
AI_FEATURE_CALL_ANALYSIS=true
AI_FEATURE_VOICE_NOTES=true
AI_FEATURE_LEAD_SCORING=true
AI_FEATURE_GUEST_INSIGHTS=true
AI_FEATURE_ASSIST=true
```

### 1. Call analysis (`call-analysis.ts`)

For each completed call: transcribe the recording (if a transcription
endpoint is configured — see below; otherwise the rep's call notes are
analysed), then produce a 0–100 quality score, kebab-case tags, a manager
summary, and coaching on **hook line, explanation, professionalism, next
steps**. Stored on `Call.ai*`, shown in the drawer's Calls tab (with a "View
full transcript" toggle) and as a score column on **/calls**. Manual
(re-)analysis: `POST /api/calls/:id/analyze`.

```bash
# optional — OpenAI-compatible /audio/transcriptions endpoint
AI_TRANSCRIBE_BASE_URL=http://whisper:8000/v1     # live default — see below
AI_TRANSCRIBE_API_KEY=
AI_TRANSCRIBE_MODEL=Systran/faster-whisper-small
ASR_LANGUAGES=                                    # empty = let Whisper auto-detect
```

**Live default: `whisper` (faster-whisper small), as of 2026-08-08.**

This reverses the 2026-07-04 decision to run `indic-asr` as the default. That
switch was made because `faster-whisper-small` was seen "repeating a single
token instead of transcribing" — the observation was real, but the diagnosis
was wrong. The repetition loop is what Whisper does when it is told to decode
audio as a language that isn't being spoken; these calls are predominantly
code-switched Indian **English**, and the config at the time forced a
Telugu/Hindi language per request. Left to auto-detect, the same model
transcribes the same audio cleanly.

Measured head-to-head on real production recordings (same file, same box):

| backend | output | repeated clauses |
|---|---|---|
| `indic-asr` (IndicConformer, full file) | **0 chars** | — |
| `whisper-small`, auto-detect | 6320 chars, 69 sentences | 1 |
| `whisper-medium`, forced `en` | 6327 chars | 57 |
| `whisper-medium`, auto-detect | 1522 chars | one token, looped |

IndicConformer returned an **empty string** for a 388-second call — it is
trained on utterance-length audio and silently produces nothing for a whole
recording rather than erroring. That empty output is what the reconciliation
LLM was then asked to turn into "a clean transcript", which is where the
fabricated transcripts came from (see the guard in
`src/lib/ai/transcript-quality.ts`). Note also that **bigger is not better
here**: `medium` degenerates into repetition loops on 8 kHz telephony audio
and is ~4x slower, so `small` is the deliberate choice, not a cost compromise.

### Alternative: whisper / faster-whisper

`docker compose --profile ai up -d whisper`, then
`AI_TRANSCRIBE_BASE_URL=http://whisper:8000/v1` and restart the app. Model
downloads on first request (~500 MB for `faster-whisper-small`). Leave
`ASR_LANGUAGES` empty so Whisper auto-detects — pinning a language is what
triggers the repetition-loop failure above.

### Alternative: AI4Bharat IndicConformer (Indian regional languages)

`infra/indic-asr/` wraps [AI4Bharat's IndicConformer](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual)
(MIT-licensed, conformer-based, all 22 official Indian languages) behind the
same OpenAI-compatible `/v1/audio/transcriptions` shape.

**It has no English code and no mixed-script output** — each request must
pick one target language (`as, bn, brx, doi, gu, hi, kn, kok, ks, mai, ml,
mni, mr, ne, or, pa, sa, sat, sd, ta, te, ur`), and the model decodes the
*entire* recording in that one script. It does not auto-detect language and
does not switch per word. On a call with English/Telugu code-switching, an
attempt decoded as `te` renders English words as **phonetic Telugu-script
transliteration** ("test" → `టెస్ట్`), not literal English text.

Note the server decodes in **25-second windows** (`ASR_CHUNK_SECONDS`) and
stitches the pieces: handed a whole call in one pass the model returns an
empty string, which is exactly how multi-minute recordings ended up with no
transcript at all.

**How the multi-language + translation step handles this:** since reps also
sometimes speak Hindi, `call-analysis.ts` transcribes each recording **once
per language in `ASR_LANGUAGES`**, then hands all attempts
to the LLM (`src/lib/ai/transcript-translate.ts`) to reconcile: determine the
actual spoken language (or a genuine mix), produce one corrected native-script
transcript, and a fluent English translation. Both are stored
(`Call.transcript` = native, `Call.transcriptEnglish` = English,
`Call.transcriptLanguage` = detected language) and both are shown in the UI.
The English translation — not the raw native transcript — is what gets fed
into the scoring/coaching prompt, since it's a more consistent input across
model changes. This reconciliation call is itself audited as an
`AiDecision` (kind `transcript_translation` — see below).

```bash
ASR_LANGUAGES=te,hi   # comma-separated; ONLY for a backend that can't auto-detect
```

With Whisper this must be left **empty** — one auto-detected pass. A single
Latin-script attempt then skips the reconciliation LLM entirely (there is
nothing to reconcile or translate), which also avoids the model truncating a
long, already-correct transcript.

Note this **doubles (or more) ASR compute per call** — one pass per
candidate language, plus the reconciliation LLM call. Fine for a background
batch job (5 calls/tick default), not something to do in a real-time path.
It still doesn't produce literal English-in-Latin-script mixed with
Telugu-in-Telugu-script in a single pass from the ASR model itself — that
correction happens at the LLM reconciliation step, which is good but not
perfect (it's inferring the likely original wording from phonetic attempts,
not literally hearing the audio). A larger Whisper model with native
multilingual code-switch detection is the alternative if this isn't accurate
enough in practice — see the `whisper` section above.

**Setup (one-time, needs your own Hugging Face identity):**
1. Sign in at huggingface.co, open the [model page](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual),
   and request access — it's a **gated** repo.
2. Create a **read** token at huggingface.co/settings/tokens.
3. Set in `.env`:
   ```bash
   HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
   ASR_LANGUAGES=te,hi   # candidate languages tried per call — no "en"
   ASR_DECODING=rnnt     # rnnt = more accurate, ctc = faster on CPU
   ```
4. `docker compose --profile ai up -d indic-asr` (first boot downloads the
   ~600M-param ONNX weights — several minutes).
5. Point the app at it: `AI_TRANSCRIBE_BASE_URL=http://indic-asr:8001/v1`,
   `AI_TRANSCRIBE_MODEL=ai4bharat/indic-conformer-600m-multilingual`, restart
   `nextjs`.

`indic-asr` and `whisper` can both be running (different ports, 8000 vs
8001) — only `AI_TRANSCRIBE_BASE_URL` decides which one the pipeline uses.

**End-to-end transcript test:** with Plivo + ngrok configured, click **Call**
on a lead, speak a scripted sales exchange, hang up. Plivo posts the recording
URL to `/api/plivo/recording-callback`, and the next pipeline tick (or
`POST /api/ai/pipeline`, or the "Analyse with AI" button on the call) fetches
the audio, transcribes it once per `ASR_LANGUAGES` entry, reconciles +
translates, and writes the score/coaching from the **English translation**
instead of the rep's notes — `Call.transcript` / `transcriptEnglish` /
`transcriptLanguage` in the DB confirm which path ran.

### 2. Voice note transcription (`voice-note-transcribe.ts`)

WhatsApp voice notes — sent from the CRM's recorder or received from a guest,
on either the Baileys or Cloud API numbers — go through the **same** ASR
endpoint as call recordings and land on the `Message` row
(`transcript` / `transcriptEnglish` / `transcriptLanguage`, plus
`transcriptError` / `transcriptAttempts` when a clip won't decode).

Two differences from calls:

- the audio comes from our own object storage, not Plivo;
- the "is this real speech" floor is far lower (`VOICE_NOTE_TRANSCRIPT_FLOOR`
  in `transcript-quality.ts`). A real note is often one clause — "haan bhej
  dijiye" — which the call floor discards as a failed decode. The floor still
  stops an empty decode reaching the reconciliation LLM, which is what
  produced invented transcripts on calls. The same gate drops Whisper's stock
  hallucinations on silence ("Thanks for watching!", subtitle credits) —
  `isAsrFillerOnly` — which clear the length floors but are not speech.

Transcription starts the moment a note is sent or received
(`queueVoiceNoteTranscription`, fire-and-forget so the webhook still answers
immediately); the pipeline sweep re-tries anything missed, up to
`MAX_TRANSCRIPT_ATTEMPTS` (3) per clip, for notes up to 30 days old —
`VOICE_NOTE_MAX_AGE_DAYS` raises that window for a one-off backfill of older
notes.

Where it shows up: a **mic icon** marks the row in the lead drawer's Activity
tab and in the Activity Log, with the English transcript underneath
(`Voice note sent` / `Voice note received`), and the transcript also appears
under the player in the WhatsApp conversation. Until the pass has run the row
reads "Transcribing…"; once it has given up it says why instead.

**Why a call can have no transcript.** `lib/ai/call-analysis-queue.ts` holds
the rules, as pure functions with tests:

- `no_answer` calls are never transcribed (ringing only) — and, just as
  importantly, are never re-queued for transcription. They were, once: the
  retry branch matched "has a recording, has no English transcript", which is
  permanently true of every unanswered call. Newest-first with a batch of 5,
  the same five calls held every slot forever — 72 ticks in six hours,
  `callsAnalyzed: 0` on all of them, two recordings decoded 144 times each,
  while ten calls from three weeks earlier had never been looked at.
- Transcription attempts are counted (`Call.transcriptAttempts`, cap 3) and
  spaced 30 minutes apart, so audio that will never decode stops.
- `Call.transcriptError` records why, and the Calls tab shows that instead of
  a blank cell.
- A tick that selects work and finishes none of it logs a warning, and a
  backlog above the batch size is logged too.
- A 401/403 from Plivo means the credentials don't cover the account holding
  that recording — recordings made before the 20 Aug account change live on
  the old account and answer 401 today. It logs at error level naming the
  cause. The attempt still counts (retrying forever is the failure mode this
  design removes), so after fixing the credential, reset the affected calls:

  ```sql
  UPDATE "Call" SET "transcriptAttempts" = 0, "transcriptError" = NULL
  WHERE "transcriptError" LIKE '%provider refused%';
  ```

### 3. Lead conversion scoring (`lead-scoring.ts`)

Open enquiries get a 0–100 conversion-likelihood score + one-line reason
(`Enquiry.aiScore/aiScoreReason`). Re-scored automatically whenever
`lastActivityAt` moves past the last scoring time. Shown as a colour-coded
badge on Kanban cards (green ≥70, amber ≥40, grey below) with the reason on
hover, and in the drawer's AI tab.

### 4. Guest insights (`guest-insights.ts`)

Guests with a completed/booked stay get a **return-likelihood** score and a
**next-programme recommendation** grounded in their (decrypted) health profile,
stay history and memberships (`Guest.aiReturnScore/aiNextProgram`). Scores ≥70
auto-create a timed **"AI outreach: …"** `Task` assigned to the lead's rep —
this is the upsell/re-engagement driver. Refreshed on a 30-day TTL.

### 5. Conversation assist (`assistant.ts`)

The **AI Assist** tab in the lead drawer calls `POST /api/ai/assist` with the
enquiry id. The agent reads the full context (profile, stage, notes, email
thread, calls incl. AI summaries, open tasks) and returns a situation summary,
ranked next actions, and a ready-to-send draft reply with a copy button.

The result is **persisted** on `Enquiry.aiAssist`/`aiAssistAt` — reopening the
drawer (or the whole app) shows the last generated suggestions immediately,
with a "Generated <time>" stamp, rather than requiring a fresh LLM call every
time the tab is opened. It only regenerates when the rep explicitly clicks
"Generate suggestions" (first time) or "Regenerate" (subsequent times).

## The background pipeline

`src/lib/ai/pipeline.ts`, started from `instrumentation-node.ts` (same pattern
as the inbound-mail poller; guarded against overlapping runs):

```bash
AI_PIPELINE_ENABLED=true         # only runs when AI_ENABLED=true as well
AI_PIPELINE_INTERVAL_SEC=300
```

Each tick runs call analysis → voice notes → lead scoring → guest insights in
small batches (5/5/8/5) so a slow local model never floods. Admins/managers can force a tick
with `POST /api/ai/pipeline` (useful right after seeding or for demos). Watch
it in the logs: `docker logs tre-nextjs | grep 'ai pipeline'`.

## AI/ML decision audit trail

Every LLM call any of the four features above makes is recorded as an
`AiDecision` row (`src/lib/ai/audit.ts`, `prisma/schema.prisma`) — independent
of whatever the "current" `Call`/`Enquiry`/`Guest.ai*` fields say after a
later re-run. Each row captures:

- **kind** — `call_analysis` | `lead_scoring` | `guest_insight` | `conversation_assist` | `transcript_translation`
- **provider + model** — exactly which LLM produced this decision (useful once
  `AI_MODEL` changes over time)
- **promptSystem + promptUser** — the *exact* text sent to the model, verbatim
- **output** — the parsed structured result (score/tags/suggestions/etc.), or
  `null` on failure
- **success + errorMessage + durationMs** — whether the call succeeded, why it
  didn't, and how long it took
- **triggeredBy / triggeredByName** — `"pipeline"` for the background job, or
  the Keycloak sub/name of the staff member who clicked "Analyse with AI" or
  "Generate suggestions"

Logging is best-effort (`logAiDecision()` never throws) so a logging hiccup
can never take down the actual AI feature it's auditing.

**Where to see it:** the **AI Audit** page (`/ai-decisions`, admin only — see
RBAC below) lists every decision with filters by type/outcome, and a detail
view showing the full prompt and output for any row. Full call transcripts
— both the English translation and the original native-script transcript —
are also viewable inline: in the lead drawer's Calls tab ("View English
translation" / "View original transcript" under any analysed call) and on
the **/calls** admin page (a transcript icon per row expands both, side by
side).

This is what makes a past scoring/coaching/insight decision **verifiable**
after the fact — you can always answer "what exactly did we send the model,
and what exactly did it say" for any decision the system has ever made, even
long after the lead/call/guest's live `ai*` fields have been overwritten by a
newer run.

## RBAC

| Endpoint / page | Permission |
| --- | --- |
| `POST /api/ai/assist` | `leads.view` |
| `POST /api/calls/:id/analyze` | `leads.view` |
| `POST /api/ai/pipeline` | `reports.allStaff` (admin/manager) |
| `GET /api/ai/decisions`, `GET /api/ai/decisions/:id`, `/ai-decisions` page | `ai.audit` (**admin only** — stricter than `/calls`, since prompts can contain health/email content) |
