# 21 — Running both boxes at once (dev + prod)

You now have two fully-working copies of the stack — `harsha-pc-ubuntu` and
`zotac-53060` — from the [server migration](./19-server-migration.md). Right
now only one can be *live* at a time: several pieces they currently share
would actively corrupt each other if both ran simultaneously. This is the
checklist to actually split them into an independent dev + prod pair,
whichever way round you decide.

No changes have been made for this yet — this is planning only.

---

## 1. Where things stand right now

| | `harsha-pc-ubuntu` | `zotac-53060` |
| --- | --- | --- |
| Currently running | **Yes** — this is the live one | No — stack stopped (not removed), Ollama service still running idle |
| GPU | RTX 4070 SUPER, 12GB | RTX 3060, 12GB |
| Database | Live, current | A snapshot from the migration — **identical app data** as of the migration, not touched since |
| Keycloak client redirect URIs | Only `harsha-pc-ubuntu` + `localhost` registered | `harsha-pc-ubuntu` **and** `zotac-53060` registered (I patched this copy only, during the migration test) |
| WhatsApp numbers connected | Both real numbers (8712623060, 8977766852) | Same two numbers' session state restored, but **not currently connected to Evolution** since evolution-api is stopped there |

The two Postgres databases have already **diverged** in one respect (the
Keycloak redirect URI list) — worth knowing before you pick which one
becomes "the" database going forward, since they're no longer byte-identical
copies of each other.

---

## 2. Why they can't both run live today

Four things are currently **shared, single-instance resources** — not
duplicated per box — and running both boxes against the same one at the same
time is exactly what breaks:

1. **The WhatsApp numbers / Evolution session state.** Both connected
   numbers' Baileys sessions are one specific login on one specific phone.
   If both boxes' `evolution-api` try to act as that same logged-in session
   at once, WhatsApp treats it as two devices fighting over one account and
   the session gets logged out / corrupted — confirmed behavior, not a
   theoretical risk (see [19 §7](./19-server-migration.md#7-verify-before-retiring-the-old-machine),
   last line).
2. **The Plivo phone number** (`+918031336757`, one number) can only point
   its answer/hangup webhooks at one URL at a time — whichever
   `PLIVO_WEBHOOK_BASE_URL` is currently set in the Plivo console. Two boxes
   both expecting inbound calls doesn't work with one number.
3. **The reserved ngrok tunnel** (`protector-sibling-exile.ngrok-free.dev`,
   one `NGROK_AUTHTOKEN`) can only be held by one running `ngrok` agent —
   this is the `ERR_NGROK_334` conflict hit during the migration test.
4. **Keycloak identity.** Both currently have (almost) the same user
   database. If both accept real logins/writes independently from here,
   "who's a real user" drifts apart between them with no reconciliation.

None of these are hard blockers — they just each need a decision below.

---

## 3. Decisions to make before touching config

Nothing below is urgent; this is the list to work through once you've
decided which box is which.

- [ ] **Which box is prod, which is dev?** (Both GPUs are comparable —
      4070 SUPER slightly ahead of the 3060 — so this isn't a
      performance-forced choice either way.)
- [ ] **Does dev need its own live WhatsApp number(s)?** If yes, budget for
      getting a second number connected (new QR scan) — it cannot share the
      production numbers. If no, dev's `messaging.send` / broadcast features
      just won't have anything to actually send with, which is fine for
      testing everything except real delivery.
- [ ] **Does dev need real inbound/outbound calling?** If yes, you need a
      second Plivo number. If no, leave dev's `PLIVO_*` vars blank —
      click-to-call UI will just error cleanly instead of ringing anything.
- [ ] **Does dev need a public HTTPS URL at all?** Only needed if dev must
      receive real Plivo webhooks. If dev is LAN/Tailscale-only, skip ngrok
      there entirely.
- [ ] **Should dev's database diverge freely, or get periodically refreshed
      from a prod backup?** The new [backup/restore scripts](./20-database-backups.md)
      make "restore last night's prod backup into dev every morning" a
      one-line cron job if you want realistic test data without dev ever
      writing back to prod.
- [ ] **One shared Keycloak realm, or a separate one for dev?** Sharing
      means the same staff logins work on both (convenient) but a role
      change on one instance's Keycloak doesn't affect the other unless
      they share the *same* Postgres — which they won't, once split. A
      separate `tre-wellness-dev` realm (or just separate dev-only accounts
      in the same realm) avoids the "which login works where" confusion.

---

## 4. TODO — once the decisions above are made

### 4a. Both boxes, regardless of which is which

- [ ] Confirm each box's `docker-compose.yml` has its own correct hostname
      baked into `NEXTAUTH_URL` / `APP_URL` / `KEYCLOAK_PUBLIC_URL` /
      `STORAGE_PUBLIC_ENDPOINT` (already true — `harsha-pc-ubuntu` has its
      own, `zotac-53060`'s was already edited during the migration test).
- [ ] Set up the [6-hourly backup cron](./20-database-backups.md) on
      **both** boxes independently once both are live — right now it's only
      installed on `harsha-pc-ubuntu`.
- [ ] Decide a naming convention for the sidebar/browser tab so staff can
      tell dev and prod apart at a glance (e.g. a banner, or just relying on
      the different hostname in the URL bar).

### 4b. Whichever box becomes prod

- [ ] Nothing new — it's already fully configured (real WhatsApp numbers,
      real Plivo number, the reserved ngrok tunnel, Keycloak realm with real
      staff). If it's `zotac-53060`, re-run the
      [migration verification checklist](./19-server-migration.md#7-verify-before-retiring-the-old-machine)
      one more time since its `evolution-api` has been stopped for a while
      (the WhatsApp session may need a fresh connect — check the WhatsApp
      Numbers admin page).

### 4c. Whichever box becomes dev

- [ ] **WhatsApp:** either connect a second, dev-only number (Admin →
      WhatsApp Numbers → Add number → scan QR with a spare phone/number), or
      accept that WhatsApp send/broadcast won't actually deliver in dev.
- [ ] **Plivo:** either provision a second Plivo number and point its
      webhooks at dev's own tunnel, or leave `PLIVO_AUTH_ID` /
      `PLIVO_PHONE_NUMBER` / `PLIVO_WEBHOOK_BASE_URL` blank in dev's `.env`.
- [ ] **ngrok:** if dev needs a public URL at all, get a **second** reserved
      domain (or a random/ephemeral one — doesn't need to be reserved for
      dev) and its own `NGROK_AUTHTOKEN`/`NGROK_DOMAIN`, distinct from
      prod's. Do not reuse `protector-sibling-exile.ngrok-free.dev`.
- [ ] **Keycloak:** if going with a separate realm, re-run the realm import
      fresh on dev instead of restoring prod's Keycloak database (or restore
      it once, then rename the realm and re-invite dev-only accounts).
- [ ] **Database:** either let it diverge freely from here, or set up the
      "restore a fresh prod backup into dev" cron using
      `scripts/restore-db.sh` (heads up: that script currently stops
      `nextjs`/`evolution-api` on whichever box it runs on to do the
      restore safely — fine for an off-hours dev refresh, just don't point
      it at prod by mistake).
- [ ] Turn off (or leave disconnected) anything dev doesn't need live —
      each unused external integration is one less thing that can leak
      test traffic into a real channel.

---

## 5. The one thing to get right no matter what

**Never let both boxes' `evolution-api` be `Up` at the same time while both
are configured with the same WhatsApp number(s).** Every other conflict in
§2 fails loudly and obviously (a stuck ngrok tunnel, a Keycloak login
rejection). A shared WhatsApp session silently degrades instead — messages
start failing to send/receive, or the number gets logged out entirely and
needs a fresh QR scan to recover. If you're ever unsure whether the other
box still has `evolution-api` running, check before starting it on the
other: `docker compose ps evolution-api` on both.
