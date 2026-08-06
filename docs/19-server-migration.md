# 19 — Moving the whole server to a different PC

Runbook for cloning this deployment — app, database, every connected
WhatsApp number, uploaded files, and settings — onto a new machine. Written
for the current single-box deploy (everything in `docker compose` on one
host, reached at `http://harsha-pc-ubuntu:3000`), moving to another single
box the same way.

Two flavors of this move, called out where they differ:

- **Same hostname** — the new PC will answer to `harsha-pc-ubuntu` too (DNS/
  hosts-file/Tailscale pointed at the new box, old one retired). Fewer
  changes needed — skip the sections marked **[new hostname only]**.
- **New hostname/IP** — the new PC is reachable at a different name. A few
  places hard-code the current hostname and need a one-time edit; each is
  called out below.

Do a **dry run on a test box first** if this is a production cutover — this
whole runbook is safe to rehearse since nothing here is destructive to the
old machine until you explicitly tear it down at the very end.

---

## 0. What actually makes up "the server"

| Piece | Where it lives | Covered by |
| ----- | --------------- | ---------- |
| App code | git repo | `git clone` / `git pull` |
| Secrets & config | `.env` (git-ignored, never committed) | manual copy |
| App DB, Keycloak DB, WhatsApp (Evolution) DB | **one** Postgres container, three databases, one volume | `pgdata` volume |
| Redis cache/queues | `redisdata` volume | volume copy (safe to skip — see §3) |
| Uploaded files (documents, health-record attachments) | MinIO | `miniodata` volume |
| **Every connected WhatsApp number's session** | Evolution API's Baileys auth state | `evolutioninstances` volume — **losing this means re-scanning a QR code for every number** |
| Whisper/IndicASR model cache | if the `ai` profile is enabled | `whispermodels`, `indicasrmodels` volumes (large — see §3 note) |
| Rendered Keycloak realm import | one-shot render output | `keycloakimport` volume (regenerated on boot — safe to skip) |
| **Ollama + the LLM model** | host-level `systemd` service, **outside Docker entirely** | not a volume — reprovisioned manually, §6 |

Everything in the first list is `docker compose`-managed; Ollama is the one
piece that lives directly on the host OS.

---

## 1. Inventory the current `.env` and hostname references

Two files hard-code the current hostname/IP for browser-facing URLs — these
are the ones that break silently on a hostname change if missed:

- **`docker-compose.yml`**, in the `nextjs` service's `environment:` block —
  currently hard-codes `http://harsha-pc-ubuntu:{3000,8080,9000}` for
  `NEXTAUTH_URL`, `APP_URL`, `KEYCLOAK_PUBLIC_URL`, `STORAGE_PUBLIC_ENDPOINT`.
  These override whatever `.env` says (see [08 — env vars](./08-env-vars.md)
  on why `STORAGE_PUBLIC_ENDPOINT` in particular must be browser-reachable,
  not just container-reachable).
- **`infra/keycloak/realm-export.template.json`** — the `tre-crm` client's
  `redirectUris`/`webOrigins` list `http://harsha-pc-ubuntu:3000/*`
  alongside the `localhost` entries. This only matters for a *fresh* realm
  import; since this migration **restores** the existing Keycloak database
  (§4), the already-imported client config travels with it as-is and this
  template isn't re-read. It only matters if you later decide to re-import
  the realm from scratch instead of restoring the DB.

**[new hostname only]** Note the new hostname/IP now — you'll need it for
§5.

Also confirm nothing in `.env` still points at the *old* physical host by
IP for something other than itself (there shouldn't be — everything backing
the app is on the same box) — `grep -n <old-ip-or-hostname> .env`.

---

## 2. Freeze writes on the old machine

Pick a short maintenance window. You don't strictly have to stop the app to
take a consistent backup (Postgres dumps are transactionally consistent
regardless), but stopping avoids the small chance of a WhatsApp message or
lead update landing in the gap between "backup taken" and "cutover."

```bash
ssh <old-host>
cd ~/Desktop/gitrepo/tre-crm-tool
docker compose stop nextjs evolution-api    # stop things that write; leave postgres/redis/minio up for the dump
```

---

## 3. Back up the databases and volumes (on the old machine)

### 3a. Database — logical dump (recommended)

A logical dump is portable across Postgres versions/architectures and lets
you verify the backup actually contains data before you trust it — safer
than a raw volume copy for a cross-machine move.

```bash
mkdir -p ~/tre-migration && cd ~/tre-migration

# All three databases (tre_crm, keycloak, and Evolution's WA_DB_NAME) live in
# one Postgres container — pg_dumpall covers all of them plus roles/passwords.
docker exec tre-postgres pg_dumpall -U postgres > all-databases.sql

# Sanity check — should be well over a few hundred KB for a real dataset, not near-empty.
ls -lh all-databases.sql
grep -c "^INSERT\|^COPY" all-databases.sql
```

### 3b. Volumes — everything Postgres doesn't cover

The WhatsApp session state (`evolutioninstances`) and uploaded files
(`miniodata`) aren't in the SQL dump — back them up as tarballs:

```bash
# docker-compose.yml pins the project name (`name: tre-crm` at the top),
# so the volumes are always prefixed tre-crm_ regardless of which directory
# the repo lives in — confirm with `docker volume ls | grep tre-crm`.
for v in miniodata evolutioninstances keycloakimport; do
  docker run --rm -v tre-crm_${v}:/data -v ~/tre-migration:/backup \
    alpine tar czf /backup/${v}.tar.gz -C /data .
done
```

**`redisdata`**: safe to skip. Redis here only holds caches, rate-limit
counters, and the transient WhatsApp/session-revocation cache — nothing
that isn't rebuilt automatically as the app runs. Don't bother restoring
it; let it start empty on the new box.

**`whispermodels` / `indicasrmodels`**: only relevant if the `ai` profile
(local transcription) is enabled. These are large (multi-GB) model caches
that re-download automatically on first use — usually faster to let them
re-download on the new box than to transfer multi-GB tarballs. Skip unless
bandwidth to re-download is a real constraint.

### 3c. Config and code

```bash
cp ~/Desktop/gitrepo/tre-crm-tool/.env ~/tre-migration/env-backup
# Confirm your git remote has every commit that's actually deployed:
cd ~/Desktop/gitrepo/tre-crm-tool && git status && git log --oneline -1
```

If `git status` shows anything uncommitted that's actually running in
prod, commit/stash it now — the new machine will only have what's in the
remote.

### 3d. Note the Ollama model (host-level, not a volume)

```bash
ollama list   # note model name(s) + tags, e.g. gemma4:latest
```

---

## 4. Move everything to the new machine

```bash
# From the old machine (or wherever you're staging the transfer):
scp ~/tre-migration/all-databases.sql        <new-host>:~/tre-migration/
scp ~/tre-migration/miniodata.tar.gz         <new-host>:~/tre-migration/
scp ~/tre-migration/evolutioninstances.tar.gz <new-host>:~/tre-migration/
scp ~/tre-migration/keycloakimport.tar.gz    <new-host>:~/tre-migration/
scp ~/tre-migration/env-backup               <new-host>:~/tre-migration/
```

`all-databases.sql` contains every password hash and every secret currently
in the DB (Keycloak users, WhatsApp instance tokens) — treat it and
`env-backup` like the most sensitive files you own in transit (`scp`/`rsync`
over SSH is fine; don't email it or drop it in a shared drive).

---

## 5. Set up the new machine

### 5a. Prerequisites

```bash
# Docker + Compose v2
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker

# Node.js ≥ 20 (needed for scripts/seed.sh and any host-side npm commands — not for running the app itself, that's containerized)
```

### 5b. Get the code

```bash
mkdir -p ~/Desktop/gitrepo && cd ~/Desktop/gitrepo
git clone <your-repo-url> tre-crm-tool
cd tre-crm-tool
```

### 5c. Restore `.env`

```bash
cp ~/tre-migration/env-backup .env
```

**[new hostname only]** Edit `.env` for anything that should genuinely
point at the new box under its new identity — in practice this is usually
nothing, since the browser-facing URLs are overridden in
`docker-compose.yml` (next step), not `.env`. Leave `.env`'s own
`NEXTAUTH_URL`/`KEYCLOAK_PUBLIC_URL`/etc. as `localhost` — that's the
existing convention here (see §1).

### 5d. **[new hostname only]** Update the hard-coded hostname

Edit `docker-compose.yml`'s `nextjs` service — replace every
`harsha-pc-ubuntu` with the new hostname/IP:

```bash
sed -i 's/harsha-pc-ubuntu/<new-hostname>/g' docker-compose.yml
git diff docker-compose.yml   # review before committing this
```

Don't touch `PLIVO_WEBHOOK_BASE_URL` here — see §5g, it's handled
separately (it's an ngrok tunnel, not the LAN hostname).

### 5e. Bring up just Postgres, then restore the database

```bash
docker compose up -d postgres
# wait for healthy:
docker compose ps postgres

# The init script (infra/postgres/init/01-create-databases.sh) already ran
# and created empty tre_crm/keycloak/evolution databases + roles on this
# fresh volume — pg_dumpall's output includes CREATE ROLE/DATABASE
# statements too, which will just no-op/skip on the already-existing ones.
docker exec -i tre-postgres psql -U postgres < ~/tre-migration/all-databases.sql
```

Watch the output for real errors (not the expected "role already exists"
noise) — a failed restore here means starting the app against an empty DB,
which is very much not what you want.

### 5f. Restore the volumes

```bash
docker compose down   # volumes just created by postgres's first boot stay; this just stops containers

for v in miniodata evolutioninstances keycloakimport; do
  docker run --rm -v tre-crm_${v}:/data -v ~/tre-migration:/backup \
    alpine sh -c "cd /data && tar xzf /backup/${v}.tar.gz"
done
```

### 5g. **[new hostname/new machine, if using Plivo]** Re-point the webhook tunnel

If `PLIVO_WEBHOOK_BASE_URL` uses a reserved ngrok domain
(`NGROK_DOMAIN` in `.env`) and that reservation + `NGROK_AUTHTOKEN` move
with you unchanged, the public URL stays the same — no Plivo-side change
needed, just bring the `ngrok` service up on the new box too
(`docker compose --profile dev up -d ngrok`, or however it's invoked here).

If you're switching to a different tunnel/domain, update **both**:
1. `.env`'s `PLIVO_WEBHOOK_BASE_URL`
2. The answer-URL / hangup-URL webhooks configured on the Plivo number
   itself, in the Plivo console — see [13 — VoIP calls](./13-voip-calls.md).
   Missing this step means calls ring but never connect.

### 5h. Bring the rest of the stack up

```bash
docker compose --profile app up -d --build
docker compose ps   # everything healthy?
```

The `nextjs` entrypoint runs `prisma migrate deploy` on boot — with a
restored DB that's already fully migrated, this should report "No pending
migrations," not apply anything new.

---

## 6. Reprovision Ollama (host-level, not part of the compose stack)

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
ollama pull gemma4:latest   # match whatever `ollama list` showed on the old box
```

Confirm `.env`'s `AI_BASE_URL` still points at
`http://host.docker.internal:11434/v1` (Docker) — see
[08 — env vars](./08-env-vars.md).

If GPU-accelerated inference was in use on the old box, confirm the new
box has an equivalent GPU + drivers before assuming performance parity —
see the GPU-sizing checklist in
[11 — production release checklist §12](./11-production-release-checklist.md#if-self-hosting-locally-current-dev-configuration).

---

## 7. Verify before retiring the old machine

Don't tear down the old box until every one of these passes on the new one:

- [ ] `docker compose ps` — every service healthy, nothing restarting in a loop.
- [ ] App loads at the new URL; login via Keycloak completes end-to-end (a
      **real** existing user, not a seed account — proves the restored
      Keycloak DB is actually being used).
- [ ] A pre-existing lead/guest from before the migration is visible with
      its full history (notes, activity timeline) — proves `tre_crm` restored.
- [ ] Health Records open and decrypt correctly for an existing guest —
      proves `HEALTH_ENCRYPTION_KEY` in the restored `.env` matches what
      encrypted the data (if this fails, you copied the wrong `.env` —
      **do not regenerate the key**, restore the correct one).
- [ ] WhatsApp Numbers admin page — every number still shows **Connected**
      with its phone number populated, *without* re-scanning a QR code —
      proves `evolutioninstances` restored correctly.
- [ ] Send a real WhatsApp test message from an existing conversation —
      proves the Evolution DB + session state + webhook wiring all work
      together.
- [ ] Upload a document / view an existing one — proves `miniodata` +
      `STORAGE_PUBLIC_ENDPOINT` are correct.
- [ ] Place or receive a test call (if VoIP is in scope) — proves the
      Plivo webhook re-pointing in §5g worked.
- [ ] AI pipeline ticks without error — `docker compose logs nextjs | grep
      "ai pipeline"` — proves Ollama reprovisioning worked.
- [ ] `docker compose logs nextjs --tail 50` — no repeating errors.

Once everything above is green **and it's stayed green for a real work
day**, decommission the old machine — or at minimum `docker compose stop`
it so there are never two live copies of the same WhatsApp session running
against Evolution API at once (that will corrupt the session).

---

## 8. Rollback

Keep the old machine powered off (not destroyed) rather than wiped, until
you're confident in the new one — same "don't delete, set aside" principle
as any other risky migration. If something's wrong post-cutover, point DNS/
the hostname back at the old box; nothing about this process is
destructive to it as long as you didn't run new writes against both
machines simultaneously.
