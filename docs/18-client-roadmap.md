# 18 — Client roadmap (Jul 20, 2026 meeting)

Tracks the decisions and action items from the Jul 20, 2026 client meeting
("Meeting Jul 20, 2026 at 16:55 IST — Notes by Gemini"). Status was verified
against the actual codebase at the time this doc was written, not assumed
from the meeting notes. Update the checkbox and status as items land.

Legend: ✅ Done · 🟡 Partially done · ⬜ Not started · ⚠️ Needs clarity (see note)

## 1. Call Routing & Missed Calls

- [x] ✅ Route incoming call to the lead's assigned owner first — updated
      2026-07-23: `pickRepForCaller()` in
      [`src/lib/calls.ts`](../src/lib/calls.ts) now checks the CRM-assigned
      rep before anything else (online, phone on file, role-eligible, not
      already on a call); falls back to the rep who last handled that
      caller, then round-robin, exactly as before
- [ ] ⬜ Test/confirm incoming-call routing in production (explicit next step
      — now covers the assigned-owner-first priority too)
- [x] ✅ Dedicated "Missed Call" tab for unknown/new guests — `unattendedOnly` filter
- [x] ✅ Date filter on the missed-call activity log — verified 2026-07-23:
      already works. `/calls`'s `dateFrom`/`dateTo` inputs combine correctly
      with both the "Missed (New Callers)" tab and `status=no_answer` on the
      general list (`src/lib/calls.ts`'s `CallsListFilter`). The one gap
      found — no date filter on an *existing lead's* Timeline tab for a
      missed call tied to that lead — is a narrower, different surface than
      what was asked; not built unless wanted.
- [ ] ⬜ Truecaller business verification — external account purchase, not code

## 2. Roles & Access Control

- [x] ✅ New "Sales Representative" role, distinct from Receptionist —
      shipped 2026-07-22: `crm-sales` / `SALES` app role, permission-identical
      to Reception (own leads + unassigned queue, messaging, tasks, own
      reports). See [06 — RBAC](./06-rbac.md).
- [x] ✅ Sales -> Reception handoff at Booking Confirmed — shipped
      2026-07-22: the moment a lead reaches Booking Confirmed (or is dragged
      straight to Converted), it's automatically unassigned and Sales loses
      **all** access to it (not just read-only) — enforced everywhere
      ownership is checked (list, stage move, edit form, tags, notes, tasks,
      timeline), not just hidden in the UI. Supersedes the old "read-only
      once Confirmed" idea below with a cleaner full-handoff model.
- [~] 🟡 Receptionist only manages a lead once it's "Confirmed Guest" — the
      Sales side of this (above) is done; **Reception's own view is
      unchanged** — they still see own-assigned **+ unassigned** leads at
      *any* stage, not gated to confirmed/converted only. Still needs a
      decision: should Reception's "claim an unassigned lead" ability go
      away entirely now that Sales owns the pre-booking queue?
- [x] ✅ Unified single login for staff doing both sales + reception duty —
      true by design (one Keycloak account = one login)
- [x] ✅ Moving a lead to "Dead" is request-only, decided by Admin/Manager —
      shipped 2026-08-03, replacing an earlier same-day direct-move version
      (which itself superseded the original 2026-07-23 approval-task design).
      Nobody — including Admin/Manager — can drag or edit a lead straight
      into `lost` any more; the only path is the Lost/Dead button in the
      lead drawer (next to the call buttons), which opens one unassigned
      task any Admin/Manager can approve or deny (Tasks -> All staff — the
      requester can approve their own request if they hold that permission).
      Approving is what actually flips the stage to `lost` and stamps
      `Enquiry.lostAt`, which an hourly sweep soft-deletes after a
      configurable number of days (default 30, admin-editable on the Users
      page) with no further approval. Denying leaves the lead exactly where
      it was. Either decision clears the request from every Admin/Manager's
      queue at once and is logged to Activity (`lost_requested`,
      `deletion_decision`, and — only on approval — `stage_change`). The
      "Staff" parking column (shipped in the direct-move version) is
      untouched by this — it's still reachable by anyone who can work the
      lead, same as any other non-Dead stage.
- [x] ✅ Staff column restricted to Admin only — shipped 2026-08-04. Manager
      (and everyone else) no longer sees the "Staff" kanban column, can't
      drag/edit a lead into it, and canWorkLeadStage excludes it from their
      view entirely (same mechanism as Doctor's consultation-only scoping).
      Checked explicitly in the stage-transition routes too, since Manager's
      `leads.manage` otherwise bypasses the general stage-visibility gate.
- [ ] ⬜ Map individual WhatsApp/phone numbers to each sales executive —
      `WhatsAppNumber` model has no per-rep assignment field
- [ ] ⬜ Restrict outgoing WhatsApp to only the rep's assigned number — verified
      any rep with `messaging.send` can currently pick any connected number
- [ ] ⬜ Restrict reception's data view to confirmed/converted only — same
      open decision as the 🟡 item above
- [x] ✅ Doctor-specific access/visibility into lead records — shipped
      2026-07-23: `DOCTOR` now has `leads.view` + `leads.consultationOnly`.
      Leads page is available to them, restricted to the Doctor Consultation
      column only, org-wide (every lead in that stage, not scoped to a
      specific doctor — there's no per-doctor assignment field). Read-only:
      can't move cards, create leads, or edit notes/tags/tasks — that's the
      separate 3-outcome workflow item below, still not built.

## 3. Lead Allotment & Pipeline

- [x] ✅ Automated lead allotment to sales reps (not drag-and-drop) — shipped
      2026-07-23. Allotment rule confirmed as simple round-robin (not
      load-based/territory). Updated 2026-07-24: cycles through Sales and
      Reception together (one shared pool, not Sales-first/Reception-only-
      as-fallback) — staying unassigned only if neither role has any staff.
      See `src/lib/lead-routing.ts`.
- [x] ✅ Add a "Payment Received" stage between consultation and confirmation —
      shipped 2026-07-23, inserted between Doctor Consultation and Booking
      Confirmed. Sales still hands off at Booking Confirmed as before (not
      moved earlier to this new stage), and it doesn't count toward
      dashboard/report "won" totals (only Booking Confirmed/Converted do) —
      both easy to adjust if the client wants different behavior.
- [x] ✅ Guest management for converted leads via status tags (not a new
      pipeline) — matches current single-pipeline + tags model
- [x] ✅ Keep current CRM workflow structure stable — process decision, ongoing
- [~] 🟡 CRM as single source of truth, phase out manual Google Sheets — CRM
      already accepts leads via a signed webhook; the "phase out Sheets as the
      staff entry point" part is a rollout/process task, not code
- [x] ✅ Bulk CSV upload for historical guest data — shipped 2026-07-23.
      "Bulk Import" on the Guests page (Admin/Manager), with a sample-CSV
      download so staff can see the exact accepted format
      (`fullName, phone, email, city, gender`). Creates/updates Guest rows
      only — no lead ticket per row, since this is a data import, not new
      leads. Existing guests (matched by phone/email) are only backfilled,
      never overwritten.
- [x] ✅ Doctor consultation: 3-outcome workflow (accept / reject / needs phone
      consult) — shipped 2026-07-23. Entering the stage opens a review task;
      the doctor gets an Accept/Reject/Needs-phone-consult banner in the
      lead drawer, recorded on the lead (`Enquiry.doctorDecision*`). Since
      Doctor can't reach the "All staff" Tasks view, their real discovery
      surface is a "Needs review" badge directly on the Kanban card.
- [ ] ⬜ Autofill medical record from intake form data — no linkage yet
- [x] ✅ Filter "Doctor" view to only show guests who've reached that stage —
      shipped 2026-07-23 (see §2). The meeting notes' "Doctor tab" is this
      same Leads page as seen by the Doctor role — there's no separate
      screen by that name in the codebase; confirmed via search before
      writing this so as not to assert a page that doesn't exist

## 4. Data Governance

- [x] ✅ Soft delete for dead/lost leads (hide, keep data) — `Enquiry.deletedAt`
- [x] ✅ Hard delete restricted to Admin only — `leads.delete`/`guests.delete`
      permissions. Extended 2026-07-22: guests themselves now get the same
      soft/hard choice as lead tickets — hard delete wipes every enquiry,
      conversation, call, document and activity entry for that guest, not
      just one ticket.
- [~] 🟡 Guest medical data restricted to authorized personnel (ISO/NABH) —
      `documents.medical`/`health.view` are Admin+Doctor only, but Doctor has
      no `leads.view` so the end-to-end workflow to reach it isn't wired
- [x] ✅ Tasks auto-removed when a lead goes lost/dead — shipped 2026-07-22

## 5. WhatsApp

- [x] ✅ Onboard & label every WhatsApp number in the CRM — admin onboarding page
- [x] ✅ Bulk WhatsApp broadcast messaging — shipped 2026-07-23. "WhatsApp
      Broadcast" on the Guests page, after the existing filters — compose a
      message (with a `{name}` token personalized per guest) and an optional
      image, pick a delay per message (default 3s ≈ 20/min, configurable),
      and it runs in the background (a new `BroadcastJob` row + an
      in-process worker tick, same pattern as the existing email
      poller/AI pipeline) rather than blocking the request like bulk email
      does. Only one broadcast at a time; the button and a progress bar show
      live status (polled) if one's already running, anywhere on the page.
- [ ] ⬜ Grant dev team Meta Business/WhatsApp Manager access — external, not code
- [ ] ⬜ ⚠️ Template creation (images, buttons) via WhatsApp Business Manager —
      **needs clarity**: which templates to submit first + content guidelines
      (24–48hr Meta approval risk, rejections on rule violations)
- [ ] ⬜ ⚠️ Carousel / catalog / "Shop Now" interactive messaging — **needs
      clarity**: explored as a native WhatsApp Business web feature; unclear
      if this needs to live inside the CRM UI or stays a direct WhatsApp
      Business Manager workflow
- [~] 🟡 ⚠️ Auto-tag/flag lead when an intake form email arrives (distinct dot
      from general activity) — a generic `needsAttention` flag already fires
      on any inbound email, but doesn't distinguish "a form was submitted"
      from any other email. **Needs clarity**: what identifies an email as
      "the form" (subject line? sender? attachment?)
- [ ] ⬜ Handle WhatsApp message deletions — found 2026-07-22 while
      investigating a message-misattribution report: the webhook handler
      only processes `messages.upsert`/`connection.update`, not
      `messages.delete`/`messages.edited`. Confirmed via raw Evolution logs
      that 6 outbound photos (sent from the paired phone directly, bypassing
      the CRM) were deleted-for-everyone on WhatsApp 2h14m after sending, but
      the CRM has no idea and still shows them permanently. Proposed but not
      yet built — pending confirmation to implement. **Distinct from** the
      new staff-facing edit/delete tagging below — this item is about
      WhatsApp-side deletions the CRM should detect and reflect automatically.
- [x] ✅ Tag WhatsApp messages as edited/deleted from the CRM side — shipped
      2026-07-23. A hover-revealed pencil/trash icon next to each message in
      the WhatsApp tab lets staff correct or redact the CRM's own copy of a
      message (e.g. a garbled transcription, a typo) — this never reaches
      WhatsApp's own servers, it only tags the local record (`Message.editedAt`/
      `deletedAt`), logged to the lead's Activity timeline either way.

## 6. Pricing & Packages

- [ ] ⬜ Discount % dropdown that auto-calculates final package price — only a
      manual `quotedPriceINR` free-text field exists, no discount logic
- [ ] ⬜ Manager approval for discounts beyond exec authority — depends on the
      discount field existing first
- [ ] ⬜ Editable message templates pre-filled with package info — no template
      system yet
- [x] ✅ Print / Save-as-PDF button for medical records (front-office check-in)
      — shipped 2026-07-23. Uses the browser's native print dialog
      (`window.print()` + a print stylesheet that hides the app chrome and
      renders the form read-only) rather than a new PDF-generation
      dependency — "Save as PDF" is one of the destinations in that dialog
      on every major browser/OS.

## 7. Google Sheets / Lead Ingestion

- [ ] ⬜ ⚠️ Configure Sheets triggers for automated lead onboarding — **needs
      clarity**: current ingestion is a generic signed webhook (Zapier-style),
      not native multi-sheet polling. Confirm whether Sheets → CRM should go
      through Zapier (already possible today) or a native Sheets-polling
      integration (new build)
- [ ] ⬜ Standardize lead-sheet formats across marketing campaigns — owned by
      Siddharth/service providers, not a CRM code task
- [ ] ⬜ Capture device/location/campaign metadata automatically — requires the
      ingestion path above to exist first

## 8. Documentation / non-code deliverables (owned by others)

- [ ] Field requirements for lead columns + guest info — Siddharth
- [ ] Allotment rules doc — Siddharth
- [ ] Pipeline columns/status-flow doc — Siddharth
- [ ] Communication/messaging style guide — Siddharth
- [ ] New-process report distribution — Siddharth
- [ ] Package pricing format examples — Medical Administrator
- [x] Meeting transcript distribution — CEO (per notes, done same day)

---

## Open clarity questions (blocking build work)

1. ~~New Sales role's exact permission boundaries vs. Reception vs.
   Manager.~~ Resolved 2026-07-22 — shipped as described in §2.
2. Reception's stage-gated access — now that Sales owns the pre-booking
   pipeline and hands off at Booking Confirmed, should Reception's own
   "claim an unassigned lead" ability go away, or stay as-is?
3. ~~Lead allotment logic (the actual rule, not just "automated").~~
   Resolved 2026-07-23 — simple round-robin, shipped as described in §3.
4. What technically marks an inbound email as "a form submission" for the
   distinct-flag requirement.
5. Google Sheets ingestion path — Zapier-via-webhook (already works) vs.
   native polling (new build).
6. Doctor's access model — they currently can't see leads at all, which
   blocks the whole 3-outcome consultation workflow.
7. Should the WhatsApp `messages.delete` gap (§5) actually be fixed, or is
   showing deleted-on-WhatsApp messages in the CRM acceptable/desired for
   audit purposes?

## Investigated separately

- **"Names in Leads didn't update after renaming in Users"** (2026-07-22):
  confirmed `StaffProfile.displayName` (source of truth) already has the new
  name, and `listEnquiries()`/`getStaffNamesBatch()` resolve it live on every
  request — not from the stale `Enquiry.assignedToName` snapshot. No bug
  found in the deployed code (`bf5fdf6`); likely a stale browser tab or a
  drawer-open pause on the auto-refresh poll. Re-check after a hard refresh.

- **"Riya Reception" still showing on 42 leads instead of "Prashanth
  Reception"** (2026-07-22): different root cause from the above. Confirmed
  via `kcadm.sh` that Keycloak already had the account renamed correctly
  (`id: 9e707cb7-...`, firstName "Prashanth", lastName "Reception") — but
  `StaffProfile.displayName` for that same `keycloakId` still said "Riya
  Reception". `updateUser()`'s own sync logic is correct and re-syncs
  `StaffProfile` on every edit made through the CRM's Users page, so this
  could only happen if the rename was done directly in the Keycloak Admin
  Console, bypassing the CRM entirely. Fixed by correcting the `StaffProfile`
  row directly (one UPDATE, fixes all 42 leads at once since names resolve
  live from this table). Process fix chosen over a code fix: **always rename
  staff through the CRM's Users page, never the Keycloak console directly**
  — documented in [16 — User management](./16-user-management.md).

- **WhatsApp images "sent to the wrong client"** (2026-07-22): traced 6
  outbound photos on a client's WhatsApp tab that looked misattributed. No
  data-integrity bug found — all 6 were sent from the paired phone's native
  WhatsApp app (not the CRM), correctly tied to the right guest throughout.
  What actually happened: the sender bundled 3 unrelated WhatsApp screenshots
  with 3 CRM-dashboard screenshots and sent all 6 to this client by mistake,
  then deleted all 6 on WhatsApp itself ~2h14m later. Confirmed via raw
  Evolution API logs (`messages.edited` → `messages.delete`, status
  `DELETED`). Surfaced the real gap: the CRM never processes delete events
  (see §5) so the deleted messages are still showing. Separately, ruled out
  a `+919848930043` cross-attribution theory — that number is squatted on by
  3 leftover seed `StaffProfile` rows (see cleanup below), so any real
  traffic on it is silently dropped by `isInternalPhone()`, not
  misattributed.

- **Seed/demo data cleanup** (2026-07-22): removed on the client's explicit
  instruction — 3 leftover seed `StaffProfile` rows (`seed-manager`,
  `seed-reception`, `seed-admin`, all squatting on the same placeholder
  phone number), 4 pure-demo leads with zero real activity (Arjun Nair,
  Divya Pillai, Meera Krishnan, Karan Malhotra — guest + enquiry + all
  history fully removed), and 5 fabricated seed emails that had gotten mixed
  into 3 real guests' conversation threads (Nishanth, Krishna, Sid — only
  the fake messages and their stale seed email addresses were removed, the
  guests and their real activity were untouched). Backed up before running.

## Shipped this session, outside the meeting's original scope

Not asked for in the Jul 20 meeting, but done in the same working sessions —
logged here for a complete record:

- **Leads per-person filter** (2026-07-23): Admin/Manager can now filter the
  leads board/list by any individual staff member, not just "My leads" —
  reuses the existing assignable-users list and an already-working backend
  filter param.
- **RNR follow-up cadence changed from 2-2-2 to 6-2-1** (2026-07-22): call
  within 6 hours, 2nd follow-up after 2 days, 3rd after 1 week.
- **Tasks auto-cleared on Lost/Dead, new tasks blocked** (2026-07-22) — see
  §4.
- **AI score shown as a colored dot, click to reveal** (2026-07-23): the raw
  `82/100`-style number (three slightly-inconsistent color schemes across
  four different places it showed up) is now one shared `ScoreBadge`
  component — a small red/amber/green dot, click reveals "AI Score: N/100".
- **Revive a soft-deleted lead on inbound activity** (2026-07-23): if a
  guest whose only lead was soft-deleted (manually, or by the new Dead-lead
  auto-delete sweep above) messages, emails, or calls in again, the ticket
  is automatically revived and moved to Contacted instead of staying hidden.
  Also fixed a real gap this surfaced: email and inbound-call resolution
  were already silently reattaching new activity to a hidden soft-deleted
  ticket without reviving it (WhatsApp's own resolver already avoided this,
  by spinning up a duplicate instead — now all three channels revive
  consistently).
