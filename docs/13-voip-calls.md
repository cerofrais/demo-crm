# 13 — VoIP calls (Plivo)

Click-to-call, inbound call routing and call recordings, built on
[Plivo](https://www.plivo.com)'s Voice API. No SDK — plain HTTP + XML in
[`src/lib/plivo.ts`](../src/lib/plivo.ts).

## Outbound (click-to-call)

The **Call** button in the lead drawer header starts a bridged call:

1. `POST /api/calls/initiate` creates a `Call` row, then asks Plivo to dial the
   **rep's phone** (from their `StaffProfile`).
2. Rep answers → Plivo hits `/api/plivo/outbound-answer` → we respond with
   `<Dial record="true">` XML bridging to the customer.
3. Recording is made server-side by Plivo; when the file is ready Plivo calls
   `/api/plivo/recording-callback?callId=…` and we store the URL.
4. Hangup → `/api/plivo/outbound-hangup` stores duration + status.

The rep never dials manually and the customer sees the business number.

## Inbound

Calls to the Plivo number hit `/api/plivo/inbound-answer`:

- `pickAvailableRep()` picks the **least-busy online rep** (`StaffProfile`
  where `isOnline` and `phone` set, fewest active calls) among the eligible
  pool.
- **Eligible pool is Reception-only by default** — controlled by the
  `CallRoutingSettings` singleton row (`scope`, defaults `"reception"`),
  set from the **Users** page ("Inbound call routing" dropdown, admin only
  via `users.manage`). Four scopes: `reception`, `sales`, `reception_sales`
  (both), or `all` (any online staff regardless of role — the original
  behavior).
- `StaffProfile.role` is a denormalized copy of the Keycloak role (`ADMIN` /
  `MANAGER` / `DOCTOR` / `RECEPTION` / `STAFF`), kept in sync by
  `keycloak-admin.ts` whenever a user is created/edited or the Users page is
  loaded. This exists so the inbound webhook — which has no session — can
  filter by role from Postgres alone instead of calling the Keycloak Admin
  API mid-call.
- Caller is matched to a `Guest` by phone when possible, and the call is
  attached to their latest enquiry.
- No rep available → polite message + hangup (`noAgentXml`). With
  Reception-only routing on, this also fires if every Reception rep is
  offline even when other staff are online — that's intentional.

## Recordings

Plivo recording URLs require Basic auth, so the browser can't stream them
directly. `GET /api/calls/:id/recording` proxies the audio with credentials —
that's what the `<RecordingPlayer>` component points at. Admins/managers see
every recording on the **/calls** page; reps see calls for their leads in the
drawer's **Calls** tab.

## Data model

`Call` (direction, status, callUUID, guest/enquiry links, rep, phones,
timestamps, duration, recordingUrl, tags, notes + the AI analysis fields — see
[14 — AI features](./14-ai-features.md)). `StaffProfile` (keycloakId,
displayName, E.164 phone, isOnline) — reps set their phone in **Settings**.

## Setup

1. Plivo console → note **Auth ID** and **Auth Token**; buy a number.
2. Create a Plivo **Application**:
   - Answer URL: `$PLIVO_WEBHOOK_BASE_URL/api/plivo/inbound-answer` (POST)
   - Hangup URL: `$PLIVO_WEBHOOK_BASE_URL/api/plivo/inbound-hangup` (POST)
   and assign it to the number.
3. Fill the env vars (below). Webhooks need a public HTTPS URL — locally use
   `ngrok http 3000` (compose ships an optional `ngrok` service under the
   `dev` profile).
4. Each rep sets their phone (E.164, `+91…`) in **Settings → Click-to-Call**.

```bash
PLIVO_AUTH_ID=
PLIVO_AUTH_TOKEN=
PLIVO_PHONE_NUMBER=        # E.164, e.g. +918012345678
PLIVO_WEBHOOK_BASE_URL=    # public HTTPS base; falls back to NEXTAUTH_URL
```

`plivoConfigured()` guards every call path — with the vars unset the Call
button returns a clean 503 and the rest of the app is unaffected.
