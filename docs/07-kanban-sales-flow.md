# 07 — Kanban board & the Trē sales flow

The pipeline columns are derived directly from the **Sales Flow** doc, not a
generic template. Single source of truth:
[`src/lib/kanban.ts`](../src/lib/kanban.ts).

## Columns (stages)

| # | Stage (`EnquiryStage`) | Board label                | Sales-flow step |
| - | ---------------------- | -------------------------- | --------------- |
| 1 | `new_lead`             | New Lead                   | Receive lead |
| 2 | `contacted`            | Contacted                  | Welcome WhatsApp + email + 6-page brochure sent |
| 3 | `rnr`                  | RNR / Follow-up            | Responded Not Reached — 6-2-1 follow-up cycle |
| 4 | `qualified`            | Qualified                  | Spoke to lead; interest understood |
| 5 | `pricing_shared`       | Pricing & Package Shared   | Pricing/location/package sent on WA/email |
| 6 | `doctor_consultation`  | Doctor Consultation        | Discovery call with the doctor scheduled/done |
| 7 | `payment_received`     | Payment Received           | Payment collected, awaiting booking confirmation *(added 2026-07-23)* |
| 8 | `booking_confirmed`    | Booking Confirmed          | Booked — dates locked |
| 9 | `converted`            | Converted                  | Checked in / stay completed |
| 10 | `lost`                | Lost / Dead                | No response after 6-2-1, or not interested |

Sales still hands off to Reception at Booking Confirmed, not at Payment
Received — they work a lead through payment collection same as before (see
[06 — RBAC](./06-rbac.md)'s `leads.preBookingOnly` note). Payment Received
doesn't count toward dashboard/report "won" totals; only Booking
Confirmed/Converted do.

### The 6-2-1 rule

From the sales flow: call within **6 hours**, 2nd follow-up after **2 days**, 3rd
after **1 week** — if still no response, mark the lead **Lost**. (Reminder
automation is a later iteration; the `Task` model already supports it.)

## Card indicators

- **Amber pulsing dot + left border** — `Enquiry.needsAttention`: set when an
  inbound email arrives on the lead or follow-up tasks are auto-created;
  cleared automatically the moment a rep opens the lead drawer.
- **Score badge** (top-right) — AI conversion likelihood 0–100 (green ≥70,
  amber ≥40, grey below), reason on hover. See
  [14 — AI features](./14-ai-features.md).

## Drag-to-assign

When a salesperson drags an **unassigned** card to any column, the move assigns
the lead to them (Stories §1). Both the assignment and the stage change are
written to the `Activity` audit log. Implemented in
`PATCH /api/enquiries/:id/stage`.

## Auto-onboarding from any source

New cards can arrive from multiple sources (goal #7):

| Source            | How |
| ----------------- | --- |
| Manual / phone    | "New lead" dialog → `POST /api/enquiries` |
| Website / landing | `POST /api/webhooks/enquiry-form` (HMAC-signed) |
| WhatsApp / IG / FB| Point the provider webhook at the same endpoint family |
| Referral link     | `?ref=CODE` carried into the form payload |

All inbound leads land **unassigned** in `New Lead` and run through
returning-guest recognition first.

### Posting a test lead to the webhook

```bash
SECRET=$(grep ENQUIRY_WEBHOOK_SECRET .env | cut -d= -f2)
BODY='{"fullName":"Test Lead","phone":"+919900000000","source":"website_form","intakeNotes":"From the landing page"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
curl -s -X POST http://localhost:3000/api/webhooks/enquiry-form \
  -H "Content-Type: application/json" -H "X-Signature: $SIG" \
  -d "$BODY" | jq
```

`intakeNotes` lands in `Enquiry.intakeNotes` — a single plain-text field
shown as "Notes" in the lead drawer, **not** a remark on the activity
timeline. This is deliberately the simplest possible target for lead-gen
automations (n8n, Zapier, etc.) to push freeform context (form Q&A, ad
details) into without a second write — one field, no Note/Activity
plumbing. (`message` is still accepted as a deprecated alias for older
integrations.) It's the same field editable from `PATCH /api/enquiries/:id`
and from the lead drawer, so notes can be added at creation and modified
later through either the CRUD API or the UI.

In dev, expose the endpoint to external providers with a tunnel, e.g.
`ngrok http 3000`, and use the public URL as the webhook target.
