# 22 — Immediate TODOs

Both items below came out of a 2026-07-26 conversation about inbound-call
handling for numbers with no matching guest/lead. Today, an unmatched
inbound call that's never answered just gets routed and logged as a `Call`
row (`guestId: null`) — nothing downstream turns it into a lead unless a
staff member manually clicks "Add as lead" on the Calls page's "Missed (New
Callers)" tab. See [18 — Client roadmap](./18-client-roadmap.md) for the
related (already-shipped) routing/missed-call-tab items this builds on.

## 1. Auto-create a lead on a missed call from an unknown number

- [ ] ⬜ **Not started.** When an inbound call from a number with no matching
      `Guest` ends up missed (`no_answer` / `voicemail`), auto-create a
      `Guest` + `Enquiry` for it instead of waiting for a staff member to
      click "Add as lead".
- Tag the new lead **"missed call"** (`Enquiry.tags`, free-text string array
  — same mechanism as any other system tag).
- Assign it via the **same round-robin strategy** already used for every
  other lead (`assignNextRep()` in
  [`src/lib/enquiry-service.ts`](../src/lib/enquiry-service.ts)) — no new
  assignment logic needed here, just call the existing path.
- `source: "phone"` (already exists in the `LeadSource` enum).
- Hook point: [`src/app/api/plivo/inbound-hangup/route.ts`](../src/app/api/plivo/inbound-hangup/route.ts),
  the `dialStatus && MISSED_DIAL_STATUSES.has(dialStatus)` branch — this is
  where `no_answer`/`voicemail` gets written today. Needs the `call.guestId`
  check (currently only used to conditionally log an Activity) extended to:
  if `guestId` is null, create the lead first, then link the call to it
  (`call.guestId`/`call.enquiryId`), same as the manual "Add as lead" flow
  does via `PATCH /api/calls/:id`.

## 2. Auto-create a lead on an answered call from a new number

- [x] ✅ **Shipped 2026-07-28** (before this doc was written up — same
      session). When an inbound call from a number with no matching `Guest`
      is picked up by an agent, the lead is now auto-created instead of
      requiring a manual click. `createLeadFromCall()` in
      [`src/lib/calls.ts`](../src/lib/calls.ts) is called from
      [`inbound-hangup/route.ts`](../src/app/api/plivo/inbound-hangup/route.ts)'s
      `finalStatus === "completed" && current && !current.guestId` branch —
      exactly the hook point and `guestId === null` gate this item asked
      for. Assigned directly to the agent who answered (`repKeycloakId`/
      `repName` off the `Call` row), not round-robin, also as specified.
  - **Deviation from the original ask:** no `"incoming call"` tag is set —
    `createLeadFromCall()` records `note: "Inbound phone call"` as
    `Enquiry.intakeNotes` instead of an `Enquiry.tags` entry. `fullName` is
    seeded from the raw phone number (no name is known from a call alone).
    Add the tag separately if it's still wanted; small, low-risk follow-up.

### Open implementation questions (not blocking, but worth deciding before building)

1. **"Picked up" signal**: `Call.answeredAt` exists in the schema/DTO but is
   never actually set by any Plivo webhook today — reaching `completed`
   status on the hangup webhook is the only current proxy for "was
   answered." Item 2 relies on this as shipped; fine, but worth confirming a
   0-duration completed call (answered then instantly dropped) should still
   count.
2. **Idempotency** (resolved for item 2, applies equally to item 1 when
   built): `inbound-hangup` can fire more than once per call (see the
   existing `alreadyClassified` guard in that file) — item 2's
   `!alreadyClassified` condition already prevents double-processing; item
   1 should use the same guard.
3. **Race with the manual flow**: a receptionist could click "Add as lead"
   from the Missed Callers tab in the same window an auto-create runs.
   Whichever writes first should win; the other should no-op rather than
   create a duplicate guest for the same phone number. Not verified either
   way for item 2 as shipped — worth a look before building item 1.
