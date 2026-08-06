# 12 — Email integration (plan)

Status: **planned, not yet built.** Locked decisions, requirements you must
provide, architecture, and a pick-up TODO checklist.

## Locked decisions
- **Send via the mailbox's own SMTP; receive via IMAP** (no transactional API in
  Phase 1). Same code path in dev (Gmail) and prod (Workspace).
- **`hello@trewellness.in` is a real inbox** staff may also read directly.
- **Guest-level threads**: a contact's full email history shows on *every* one of
  their leads, not isolated per enquiry.
- **One shared identity**: everything sends as `EMAIL_FROM`; replies return to the
  same inbox and are matched back in.
- **Inbound poller runs in-process** (node-cron on app startup) for Phase-1 scale.
- **Unmatched inbound auto-creates a lead**: if a sender isn't a known guest and
  the message doesn't thread to one of ours, auto-create a `Guest` + `Enquiry`
  with **`source=email`** (a new `LeadSource`) so nothing is lost — it lands in
  `new_lead` like any other inbound, unassigned, and runs through returning-guest
  recognition.
- **Phasing**: A) send-only → B) inbound threading + auto-create → C) prod hardening.

## Can we use Mailhog?
Sending: yes (dev SMTP sink, UI :8025). Threading: no — Mailhog has no IMAP and
never delivers mail, so real replies can't arrive. Test inbound against Gmail/Workspace.

## What you must provide

### Dev (Gmail)
- Gmail account with **2-Step Verification ON**.
- Generate a **Gmail App Password** (Account → Security → App passwords).
- **Enable IMAP** (Settings → Forwarding and POP/IMAP).
- `.env`:
  - `SMTP_HOST=smtp.gmail.com` `SMTP_PORT=587` `SMTP_SECURE=false`
  - `SMTP_USER=<gmail>` `SMTP_PASS=<app password>`
  - `IMAP_HOST=imap.gmail.com` `IMAP_PORT=993` `IMAP_USER=<gmail>` `IMAP_PASS=<app password>`
  - `EMAIL_FROM="Trē Wellness <gmail>"` (Gmail forces From = the account unless a verified alias)

### Prod (`hello@trewellness.in`, real inbox)
- Confirm host (Google Workspace assumed); get SMTP+IMAP creds (App Password if Workspace).
- DNS for `trewellness.in`: **SPF, DKIM, DMARC** (provider gives exact records) — else mail lands in spam.
- `EMAIL_FROM="Trē Wellness <hello@trewellness.in>"` + mailbox SMTP/IMAP host/creds.

## Architecture

### Sending (Phase A)
- `nodemailer` SMTP transport from env (provider-agnostic).
- `POST /api/messages/email` — `{ guestId, enquiryId?, subject, bodyText, bodyHtml? }`.
  - Permission `messaging.send` (Admin/Manager; Reception on own leads).
  - Generate + store RFC `Message-ID`; `From`/`Reply-To` = `EMAIL_FROM`.
  - On reply, set `In-Reply-To` + `References` to the prior message.
  - Persist `Message(direction=outbound)`, write `Activity(message_sent)`.
  - On failure: `status=failed` + error; UI retry.

### Receiving + threading (Phase B)
- In-process `imapflow` poller every `EMAIL_POLL_INTERVAL_SEC` (~120s) reads INBOX.
- Dedupe by IMAP UID / `Message-ID` (unique column) — idempotent re-polls.
- Match inbound → guest: (1) `In-Reply-To`/`References` → our stored Message-ID,
  else (2) sender email → `Guest.email`; **no match → auto-create a `Guest` +
  `Enquiry` with `source=email`** and link the message to it.
- Store `Message(direction=inbound, guestId)`. Thread is guest-level.

### Edge cases
- Single shared mailbox → thread linkage via `References` headers + sender fallback.
- Multiple enquiries per guest → show whole history on each lead drawer (guest-level).
- Attachments: store via existing MinIO/Documents pipeline (Phase B+).
- Auto-created leads from email: subject becomes the first note; guest name falls
  back to the From display-name (or the local-part) until a human edits it.

## Data-model changes (Prisma — extend `Message`)
- `guestId String?` (+ relation, index) — guest-level threads
- `subject String?`, `bodyHtml String?` (keep `body` as text)
- `fromEmail String?`, `toEmail String?`
- `messageId String? @unique`, `inReplyTo String?`, `references String[]`
- keep `direction`, `status`, `externalId`; add migration (non-breaking).
- **Add `email` to the `LeadSource` enum** (for auto-created inbound leads).

## UI
- **Email tab** in the lead drawer (alongside Details / Remarks / Documents / Activity):
  - Threaded guest email history; inbound vs outbound styled distinctly; chronological; expandable.
  - Compose: To (prefilled), Subject, Body, Send; reply pre-fills `Re:` + threads via headers.
  - Empty/disabled states (no guest email, or no `messaging.send`).

## Env vars (add)
- `EMAIL_INBOUND_ENABLED=true|false`, `EMAIL_POLL_INTERVAL_SEC=120`, `SMTP_SECURE=false`
- (existing) `EMAIL_PROVIDER`, `EMAIL_FROM`, `SMTP_*`, `IMAP_*`

## Dependencies (add)
- `nodemailer` (+ `@types/nodemailer`) — sending
- `imapflow` + `mailparser` (+ types) — receiving/parsing

---

## TODO checklist (pick up here)

### Phase A — Send only (testable on Mailhog)
- [ ] Add deps: `nodemailer`, `@types/nodemailer`.
- [ ] `src/lib/mailer.ts`: env-driven nodemailer transport; `sendEmail()` returns the `Message-ID`.
- [ ] Extend `Message` model + migration (subject, bodyHtml, fromEmail, toEmail, messageId@unique, inReplyTo, references[], guestId).
- [ ] `POST /api/messages/email` (Zod, `messaging.send`, send, persist outbound, Activity, failure handling).
- [ ] `GET /api/guests/:id/messages` — guest-level email thread.
- [ ] Lead drawer **Email tab**: thread (outbound) + compose/send; refresh on send.
- [ ] Verify: send → appears in Mailhog UI + Email tab; Activity logged.

### Phase B — Inbound threading + auto-create (needs real Gmail/IMAP)
- [ ] Add deps: `imapflow`, `mailparser` (+ types).
- [ ] Add `email` to the `LeadSource` enum (migration).
- [ ] `src/lib/inbound-mail.ts`: IMAP connect, fetch unseen, parse, dedupe.
- [ ] Matching: References/In-Reply-To → stored Message-ID; fallback sender→guest;
      no match → auto-create Guest + Enquiry (`source=email`) via the existing
      `createEnquiry` path (returning-guest recognition still applies).
- [ ] Persist inbound; track last UID / mark seen.
- [ ] node-cron scheduler gated by `EMAIL_INBOUND_ENABLED`; start on boot; no overlapping runs.
- [ ] Email tab shows two-way thread; reply threads via headers.
- [ ] Verify: reply from a normal mail client → shows in the lead within the poll interval;
      a brand-new sender → a fresh `source=email` lead appears on the board.

### Phase C — Prod hardening
- [ ] Point env at `hello@trewellness.in` (Workspace SMTP/IMAP).
- [ ] SPF / DKIM / DMARC DNS records; deliverability test.
- [ ] Rate-limit sends (Redis) per user; cap attachment size; sanitize HTML.
- [ ] Refine unmatched-inbound handling (spam/allowlist filtering before auto-create;
      base behavior — auto-create `source=email` — is locked).
- [ ] DPDP: access-control + audit on email view/send; retention.
- [ ] (Optional) move poller to a dedicated `worker` container if volume grows.
