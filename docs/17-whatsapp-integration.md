# 17 — WhatsApp integration (Evolution API)

WhatsApp is self-hosted via [Evolution API](https://github.com/EvolutionAPI/evolution-api)
(`evoapicloud/evolution-api:v2.3.7`), connected in **Baileys** mode — it mimics
WhatsApp Web via a QR-code pairing, the same way WhatsApp Web itself works.
No Meta Business account, app review, or per-message cost.

**Read this before connecting a real number:** Baileys is an unofficial,
reverse-engineered protocol. WhatsApp can detect and ban a number using it at
their discretion, with no appeal process — this is explicitly a risk, not a
hypothetical. Recommended path: connect a secondary/test number first to
prove the integration, and treat moving the primary front-office number to
this as a business decision, not an engineering one. If the volume/reliability
bar rises, Evolution API also supports the official Meta Cloud API mode per
instance — same instance-management flow, no app rework needed to switch.

## Architecture

One **instance** = one connected WhatsApp number. Multiple numbers just means
multiple instances — Evolution is built for many isolated sessions from one
deployment. Right now every connected number is visible to every role in the
send-from dropdown (no per-role split, e.g. Manager gets a different number
than Reception) — that was an explicit choice to keep the first cut simple;
if it's needed later it's a `WhatsAppNumber`-to-role mapping, not a redesign.

```
Evolution API (Baileys) ──webhook──▶ POST /api/webhooks/whatsapp ──▶ Message row
        ▲                                                                │
        │                                                     needsAttention on lead
   QR pairing                                                            │
        │                                                                ▼
/whatsapp-numbers (admin)                                    WhatsApp tab in lead drawer
        │                                                     GET /api/guests/:id/whatsapp
POST /api/admin/whatsapp/numbers                              POST /api/messages/whatsapp
```

- **`WhatsAppNumber`** (Prisma) — one row per instance: label, phone number
  (filled in once paired), `instanceName` (also used as `Message.mailboxId`,
  the same way email uses `"sales"`/`"doctor"` — no FK, just a string, so
  deleting a number never touches message history), instance token, status,
  `isDefault`.
- **`Message.channel = "whatsapp"`** and the `whatsapp` source enum value on
  `Enquiry` both already existed in the schema before this feature — reused
  as-is, no migration needed for either.
- **Inbound** is push-based (Evolution posts to us), not polled like email's
  IMAP — Evolution has no "check every N seconds" step to configure.
- **Auto lead creation**: an inbound message from an unknown phone number
  creates a new enquiry (`source: "whatsapp"`), exactly like an unmatched
  inbound email — same `needsAttention` flag so it lights up on the Kanban
  board.
- **One thread per guest**, not per number — unlike email's sales/doctor
  split, all connected WhatsApp numbers share a single conversation view per
  guest. The number selector in the tab only controls which number an
  *outbound* message sends from.

## One-time setup (new deployment)

1. `docker compose up -d` brings up `evolution-api` alongside everything
   else — no separate step, it's a normal service now (`docker-compose.yml`).
   It has its own Postgres database (`WA_DB_*` env vars, created by
   `infra/postgres/init/01-create-databases.sh` alongside the CRM and
   Keycloak databases) and uses the shared Redis on db index 1 (app itself
   uses db 0 — separate keyspaces, no collision).
2. Set real secrets in `.env`: `WA_DB_PASSWORD`, `EVOLUTION_API_KEY` (used by
   *both* the `evolution-api` container's `AUTHENTICATION_API_KEY` and the
   app's outbound calls — must match), `WHATSAPP_WEBHOOK_SECRET`.
3. `prisma migrate deploy` picks up the `WhatsAppNumber` migration
   automatically (already wired into `entrypoint.sh`, same as every other
   migration).
4. Sign in as an admin → **WhatsApp Numbers** in the sidebar → **Add
   number** → scan the QR with the phone that owns the number (WhatsApp →
   Settings → Linked devices → Link a device). Once connected it shows the
   detected phone number and appears in every WhatsApp tab's dropdown.

### Deploying onto an *already-running* box

Same caveat as the Keycloak realm and the storage `STORAGE_PUBLIC_ENDPOINT`
fix from before: `docker-compose.yml` changes take effect on `docker compose
up -d`, but the **postgres init script only runs on a fresh, empty data
volume** — an already-running postgres container won't pick up the new
`WA_DB` automatically. Create it manually once, mirroring exactly what the
init script does for a fresh install:

```bash
docker compose exec -T postgres psql -U "$POSTGRES_SUPER_USER" -d postgres <<-EOSQL
    CREATE ROLE "$WA_DB_USER" LOGIN PASSWORD '$WA_DB_PASSWORD';
    CREATE DATABASE "$WA_DB_NAME" OWNER "$WA_DB_USER";
    GRANT ALL PRIVILEGES ON DATABASE "$WA_DB_NAME" TO "$WA_DB_USER";
EOSQL
docker compose exec -T postgres psql -U "$POSTGRES_SUPER_USER" -d "$WA_DB_NAME" <<-EOSQL
    GRANT ALL ON SCHEMA public TO "$WA_DB_USER";
    ALTER SCHEMA public OWNER TO "$WA_DB_USER";
EOSQL
```

Then `docker compose up -d evolution-api` — it runs its own migrations
against that fresh database on startup.

The `WhatsAppNumber` Prisma migration (`20260715120000_whatsapp_numbers`) was
hand-written rather than generated against a live shadow database (no local
Postgres available in the authoring environment) — it's a single
self-contained `CREATE TABLE`, no relations to existing tables, so the blast
radius of a mistake is low, but **verify `prisma migrate deploy` applies
cleanly** the first time this branch actually deploys, before relying on it.

## Env vars

| Var | Purpose |
| --- | --- |
| `WA_DB_NAME` / `WA_DB_USER` / `WA_DB_PASSWORD` | Evolution API's own database, same shared postgres |
| `EVOLUTION_API_URL` | Internal URL the app uses to call Evolution's REST API (`http://evolution-api:8080` in compose) |
| `EVOLUTION_API_KEY` | Global admin key — same value in both the app's env and `evolution-api`'s `AUTHENTICATION_API_KEY` |
| `WHATSAPP_WEBHOOK_SECRET` | Query-param shared secret Evolution appends to its webhook calls to `/api/webhooks/whatsapp` |
| `WA_BUSINESS_TOKEN_WEBHOOK` | Official Cloud API mode only (see below) — verify token Evolution checks against Meta's webhook handshake |

## Permissions

- **`whatsapp.manage`** (Admin only) — the `/whatsapp-numbers` onboarding
  page and its API routes. Same shape as `users.manage` for the Users page.
- **Sending/reading** the WhatsApp tab uses the existing `messaging.send` /
  `leads.view` permissions — no new permission for day-to-day use, matching
  "numbers are shared across all roles for now."

## Media (images, voice notes, documents)

Both directions are handled, reusing the same `Document`/MinIO storage the
Documents tab and email attachments already use — a media message is a real
`Document` row (visible in the Documents tab too), linked to its `Message`
via `Message.attachmentDocumentId` so the chat bubble can render it inline
(image thumbnail, native `<audio>` player, or a download link for anything
else) rather than just pointing at another tab.

- **Inbound**: WhatsApp media is end-to-end encrypted — the webhook payload
  only carries metadata (mimetype, caption, and a document's filename), not
  bytes. On seeing `imageMessage` / `videoMessage` / `audioMessage` /
  `documentMessage` / `stickerMessage` in `messages.upsert`, the webhook
  calls Evolution's `POST /chat/getBase64FromMediaMessage/{instance}` to
  fetch (and have Baileys decrypt) the actual bytes, then stores them the
  same way an admin file-upload does. Deliberately **not** using Evolution's
  inline `webhook_base64` option — it has multiple open reliability issues
  across versions as of this writing, whereas the dedicated fetch call is a
  documented, stable endpoint. If the fetch fails (network hiccup, a
  since-expired media key), the message still gets stored with a
  `"[Media message — download failed]"` body rather than being dropped.
- **Outbound**: the paperclip button in the WhatsApp tab reuses the exact
  upload-url → browser PUT → confirm sequence from the Documents tab and
  email attachments, then the send route fetches those bytes server-side and
  routes to Evolution's `sendMedia` (image/video/document) or
  `sendWhatsAppAudio` (native voice-note UI on the recipient's end,
  triggered by an `audio/*` mimetype) endpoint. The textarea becomes the
  caption; a photo/voice-note with no caption is a valid, empty-body send.

## Auto-reply

`/autoreplies` (`whatsapp.manage`/`whatsapp.view`, same split as number
management) lets an admin configure automatic text replies per number. Each
config has: the number it applies to, an optional trigger word, the reply
text, and an on/off toggle. A number can have several — one per trigger word,
plus at most one with a blank trigger word acting as a catch-all for
everything else.

- **Matching** (`lib/whatsapp-autoreply.ts`'s `matchAutoReply()`, pure/unit
  tested): case-insensitive substring match against the inbound message
  body, checked in creation order — first trigger-word match wins; the
  catch-all only fires if nothing more specific matched.
- **Firing**: `maybeSendAutoReply()` runs from the inbound webhook
  (`api/webhooks/whatsapp/route.ts`) right after a genuine guest message
  (`fromMe: false`) is stored — never on a rep's own-phone traffic. It sends
  through the same `sendWhatsAppMessage()` used everywhere else and records
  its own outbound `Message` + `Activity` row (`actorSub: "whatsapp-autoreply"`).
- **Loop/spam guard**: skips sending if an auto-reply already went to that
  guest on that number within the last 60 seconds (checked via the
  `Activity` log) — nothing else in the codebase throttled automated sends
  before this, and without it a guest sending several messages in a row (or
  two auto-reply-enabled numbers messaging each other) would get spammed.
- Best-effort throughout: any failure is logged and swallowed, never thrown
  — it can't break inbound message storage.

## What's not built yet

- **Per-role number assignment** — see the note in Architecture above.
- **Submitting/editing message templates from this app** — templates are
  created and reviewed entirely in Meta's WhatsApp Manager; this app only
  reads them (list + status), it doesn't submit new ones.
- **Group chats** — the webhook explicitly skips anything not a 1:1 DM
  (`remoteJid` not ending in `@s.whatsapp.net`); this is a lead-conversation
  tool, not a broadcast/group inbox.

## Official Meta Cloud API mode (for numbers that need Meta's blessing)

Baileys (above) is fine for low-volume, rep-driven conversations, but it's an
unofficial protocol — WhatsApp can and does ban numbers it catches doing
bulk/automated sending through it, no appeal. A number used for real
bulk/marketing sends should instead go through Evolution's `WHATSAPP-BUSINESS`
integration type, which talks to the official Meta Cloud API. `/whatsapp-numbers`
→ **Add number** → **Official Cloud API** does this end to end: it validates
the token/Phone Number ID against Meta before creating anything, creates the
Evolution instance, and persists a `WhatsAppNumber` row with
`integration: "cloud_api"` plus the WABA id / Phone Number id / permanent
access token (`whatsapp-admin.ts`'s `createInstance()` takes an optional
`CloudApiConfig` for this — Baileys numbers are unaffected, same call with no
second argument).

**Prerequisites you still do by hand in Meta's console** (nothing here
automates these): create a Meta App with the WhatsApp product, connect it to
the business's WABA, verify the phone number (OTP) and set its 2-step PIN,
and create a System User with `whatsapp_business_management` +
`whatsapp_business_messaging` permissions to generate the permanent access
token the admin UI asks for.

**Webhook**: Meta's Cloud API needs to reach Evolution API's own webhook
receiver (`{EVOLUTION_API_URL}/webhook/meta`) directly over the public
internet — Evolution implements Meta's verify handshake and event ingestion
itself there, gated by `WA_BUSINESS_TOKEN_WEBHOOK`. This deployment's only
public entry point is the app (via ngrok in this setup — see the comment on
the `ngrok` service in `docker-compose.yml`), so `/api/webhooks/whatsapp-cloud-relay`
exists purely to forward Meta's calls through to Evolution's real receiver —
it has no webhook logic of its own. In Meta's app dashboard (WhatsApp →
Configuration), set:
- **Callback URL**: `https://<public-app-domain>/api/webhooks/whatsapp-cloud-relay`
- **Verify token**: the same value as `WA_BUSINESS_TOKEN_WEBHOOK`

Once connected, a Cloud API number behaves like any other `WhatsAppNumber`
for 1:1 conversation (same `Message` rows, same WhatsApp tab, same
`/api/messages/whatsapp` send route — that path still sends free text, which
is fine inside an open 24h customer-service window).

**Bulk broadcast is different**, because a template is mandatory outside that
window: `src/lib/whatsapp-cloud-api.ts` calls Meta's Graph API directly
(bypassing Evolution, which doesn't cleanly abstract template sends across
both integration types) for two things —
`GET /{waba-id}/message_templates` (surfaced via
`GET /api/admin/whatsapp/numbers/:id/templates`, readable by anyone with
`messaging.send`, not just `whatsapp.manage` admins, since the broadcast
composer needs it too) and `POST /{phone-number-id}/messages` with
`type: "template"`. The Guests-tab broadcast dialog detects a Cloud API
"send from" number and swaps the free-text composer for a template picker +
positional `{{1}}`, `{{2}}`… parameter inputs (each may contain
`{name}`/`{salutation}`, personalized per recipient same as a free-text
broadcast); `BroadcastJob.templateName`/`templateLanguage`/`templateBodyParams`
carry this through the existing paced background sender in
`src/lib/broadcast.ts`. Only `APPROVED` templates are selectable — `PENDING`/
`REJECTED`/others show in the read-only admin template list (via the
per-number "view templates" action on `/whatsapp-numbers`) but not in the
broadcast picker. `hello_world` is Meta's default template on every new
WABA — the fastest way to prove a number can actually send before your own
templates finish review.

### Marketing Messages API (MM Lite) — `WHATSAPP_MM_API_ENABLED`

Meta's Cloud API sends marketing templates without regard for whether the
recipient is likely to engage, and gates them after the fact with error
**131049** ("in order to maintain a healthy ecosystem engagement, the message
failed to be delivered"). On this deployment that single code accounted for
**495 of 649** outbound WhatsApp failures over ten days — a 63% failure rate
on the Cloud API number, rising day over day (1 → 177 → 317) as Meta throttled
harder.

The Marketing Messages API (formerly MM Lite) is Meta's answer to exactly
that: the same request body posted to `POST /{phone-number-id}/marketing_messages`
instead of `/messages`, run through the engagement ranking behind Meta's ads
ecosystem. Same WABA, same approved templates, no migration — it runs
*parallel* to the Cloud API rather than replacing it, and Meta has signalled
that marketing will eventually move to it exclusively.

Wiring here:

- `WHATSAPP_MM_API_ENABLED=true` turns it on. It is a kill switch, not a
  migration — set it back to `false` and everything returns to `/messages`
  without a deploy.
- **Only `MARKETING` templates are eligible.** Meta rejects utility,
  authentication and service templates on that endpoint, so
  `shouldUseMarketingApi()` in `src/lib/broadcast.ts` fails closed: anything
  that isn't a confirmed `MARKETING` category — including a category lookup
  that failed — stays on the Cloud API path.
- The category is resolved **server-side from Meta** at job creation
  (`listMessageTemplates`), never taken from the request body: it decides
  which endpoint real sends go to, so a client-supplied value would be a way
  to have every message rejected.
- `BroadcastJob.templateCategory` and `BroadcastJob.usedMarketingApi` record
  the decision per job. The flag is read once at creation, so flipping the env
  mid-run can't split one job across both endpoints, and an old job's path
  stays attributable after the env changes. The Broadcast Status page shows a
  "Marketing API" badge on jobs that used it.

**What it does not fix.** 131049 is the bulk of the failures but not all of
them: 131047 (24h window expired — needs a template, not free text), 131026
(undeliverable number) and 130472 (recipient in a Meta experiment) are
unaffected. Meta's own A/B test claims up to 9% better delivery, so expect an
improvement, not an elimination — a 63% rejection rate also points at audience
quality and send pacing (`BroadcastJob.delaySec`, currently 1s), which no API
change addresses.
