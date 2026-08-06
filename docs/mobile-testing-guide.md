# Local testing guide — responsive (mobile/tablet) work

How to exercise every tab locally before pushing to `main`/live.

## 1. One-time setup

```bash
# Start Docker Desktop, then bring up the stack:
docker compose up -d          # postgres, keycloak, redis, minio

# If Keycloak fails to bind :8080 on Windows ("access forbidden"), the WinNAT
# service has reserved the port range. In an ADMIN terminal:
net stop winnat && net start winnat
docker compose up -d          # re-run; Keycloak binds 8080 now

# Seed sample data so every tab has content:
npm run db:seed
```

## 2. Run the app (hot reload)

```bash
npm run dev                   # http://localhost:3000
```

`next dev` works again after externalizing pino's worker packages in
`next.config.mjs` (they broke worker-module resolution under dev). Log in as the
seeded **admin** user.

> Note: the non-admin seed users (doctor/manager/reception/staff) only get a
> working password if `SEED_*_PASSWORD` are set in `.env`; otherwise test with
> admin and switch roles via the Users screen.

## 3. Test matrix

Use Chrome DevTools device toolbar (Ctrl+Shift+M) and check three widths per tab:

| Tier | Width to test |
|------|---------------|
| Phone | 390 × 844 |
| Tablet | 820 × 1180 (also try 768) |
| Desktop | 1440 |

**Tabs to walk** (every nav destination + the lead-drawer inner tabs):

- [ ] Leads — pipeline (Kanban) **and** list view; open a lead → drawer → each inner tab (Details, Conversation, Assist, Calls, Documents); "Move to stage"; new-lead form; filters
- [ ] Guests — search, open a guest, bulk-select + bulk email
- [ ] Tasks
- [ ] Health Records — list → record, Record/Conversation toggle
- [ ] Calls — list, expand a row (recording/transcript), stats
- [ ] Reports — matrix
- [ ] Users — table, add/edit user, actions
- [ ] Packages / Referrals / Resources / Settings / AI-decisions
- [ ] Dashboard

**Per screen, confirm:**
- No horizontal scroll on the page body (wide content scrolls only inside its own container).
- All tap targets ≥ 44px; inputs don't trigger iOS zoom (16px on phone/tablet).
- Drawer + bottom nav (phone) and icon rail + expand toggle (tablet) work.
- Nothing overlaps the bottom nav; the shell chrome stays fixed while content scrolls.
- Desktop (≥1024px) is unchanged from before.

## 4. Gates before commit (each phase)

```bash
npx tsc --noEmit      # 0 errors
npx next lint         # clean
npx next build        # exit 0  (use `npx next build`, not `npm run build`,
                      # if prisma generate hits a Windows file lock)
```

Playwright viewport-screenshot automation is deferred (see spec §8); manual matrix
+ these gates are the current bar.
