# Daily marketing lead report

**Reports → Marketing** (`/reports/marketing`, `reports.allStaff`).

One CSV per day, listing every lead received that day with its campaign
breakdown, follow-up history and current temperature. Generated automatically
each morning for the previous day and emailed to the CEO; also generatable by
hand for any date range.

Code: `src/lib/marketing-report.ts`, `src/components/reports/marketing-reports.tsx`,
`src/app/api/reports/marketing/**`. Table: `MarketingReport`.

## Where each column comes from

The requested field list didn't map one-to-one onto stored columns, so the
report mixes three kinds of value. The page repeats this distinction for the
people reading the CSV, and marks the derived ones.

**Stored** — read straight off the record: lead id, received-at, name, phone,
email, city, campaign label, assigned rep, stage, lost reason, next follow-up
(the lead's next open task).

**Parsed out of `Enquiry.intakeNotes`** — the n8n Meta Lead Ads integration
writes the form's question/answer pairs there as `Key: value` lines, followed
by three meta lines:

```
Biggest health challenge: stress_&_fatigue
Wellness focus: experience_
Ad: CG_Trewellness_FBIG_NRI-Lead_Hyderabad-PostalCode_28July2026_Ad2_Video
Form: CG_Trewellness_FBIG_NRI-Lead_Hyderabad-PostalCode_23June2026
Submitted: 2026-08-10T00:14:23-05:00
```

`parseIntake()` splits the `Ad`/`Form`/`Submitted` lines from the real answers.
There are no dedicated columns for any of this — it only exists as that blob.

**Derived from the naming convention** — platform, ad set and creative.
**Meta's real adset/ad ids are never sent to the CRM.** What we have is the
agency's naming scheme, so `parseCampaignParts()` reads:

| Part | How | Example |
| --- | --- | --- |
| Platform | `FBIG`/`FB`/`IG`/`GOOGLE`… token, delimiter-matched so `FBX` can't match `FB`. Falls back to `Enquiry.source`. | `Meta (Facebook / Instagram)` |
| Creative | trailing `Ad<N>_<Format>` | `Ad1_Video` |
| Ad set | whatever the ad name adds over the campaign name, minus the creative | `Remarket` |

All three go blank when a campaign is named differently — that's expected, not
a bug. Getting the real ids would mean changing the n8n workflow to send them.

Note the campaign fallback: 35 leads on this deployment have no
`campaignLabel` but do carry a `Form:` line, and the agency names the form
after the campaign, so the form name is used as the campaign for those. That
also makes the ad-set split work, since it's computed by subtracting the
campaign prefix from the ad name.

**Computed from history** — follow-up first/latest/count, remarks, lead
status, detailed remarks. A follow-up **attempt** is us reaching out: an
outbound message or an outbound call. A guest's reply is not our attempt, and
a note is a remark *about* an attempt rather than one itself.

## Hot / Warm / Cold / Dead

Management's definitions are behavioural, so `classifyTemperature()` reads
behaviour — whether the guest has ever replied, how recently, and what the
rep's remarks say. It is deliberately **deterministic and keyword-based, not an
LLM call**: this feeds a management report that has to be reproducible and
explainable, and must not give a different answer on a re-run over the same
data.

| Status | Rule |
| --- | --- |
| **Hot** | Guest replied within the last 7 days (`HOT_REPLY_WINDOW_DAYS`) — "a conversation that is going on". Booked/converted/paid leads too. |
| **Warm** | Has replied at some point but not confirmed: callback requested, "will come later", or the thread has simply gone quiet. |
| **Cold** | Never replied at all, **or** an explicit no — not interested, price too high, dropped out. |
| **Dead** | Stage is `lost`. |

Two ordering decisions worth knowing:

- **An explicit no outranks an active conversation.** A guest who chatted
  yesterday and then said "too expensive" is Cold, not Hot.
- **A live conversation outranks the warm keywords**, so an active thread that
  happens to contain "next week" stays Hot.

`Dead` is kept separate from `Cold` so Cold keeps meaning "gone quiet" rather
than being overloaded with "formally lost".

## Scheduling

`tickDailyMarketingReport()` runs every 15 minutes from
`instrumentation-node.ts` and does nothing until `MARKETING_REPORT_HOUR_IST`
(default 07:00 IST). It builds **yesterday's** report, not today's — a report
for a day still in progress would be incomplete the moment it landed.

The "already done" guard is the `MarketingReport` row, **not** an in-memory
flag: a restart, a redeploy or a second app instance would each re-fire a
timer-only schedule and the CEO would get the same report several times. Since
`reportDate` is unique, "yesterday already has a report that has been emailed"
is the authoritative answer.

The whole tick body sits inside its `try`. The caller invokes it as
`void tick()`, so anything thrown *outside* a catch becomes an unhandled
rejection that disappears without a log line — which is exactly how the first
deploy of this scheduler failed silently, generating nothing and reporting no
error.

```bash
MARKETING_REPORT_TO=ceo@trewellness.in
MARKETING_REPORT_HOUR_IST=7
```

Email goes out from the **sales mailbox**, so `SALES_SMTP_*` must be
configured. Without it the report is still generated and downloadable, and the
page shows the send failure on the row rather than silently looking unsent.

## Manual generation

Two buttons, both requiring `messaging.send` on top of `reports.allStaff` (a
read-only Viewer can open the page and download, but not generate or send):

- **Generate yesterday's** — same as the scheduled run. Re-running replaces
  that day's file and clears its emailed state, so the numbers refresh.
- **Date range** — any window up to a year, both ends inclusive. Stored with
  `reportDate` NULL so a custom range can't occupy a calendar day's unique
  slot (Postgres allows many NULLs under a unique index); `rangeStart`/
  `rangeEnd` record the window covered. The storage key carries the generation
  instant, so regenerating a range doesn't overwrite the object an existing
  download link still points at.

Downloads stream through `/api/reports/marketing/:id/download` rather than a
presigned storage URL, so the permission check applies to every fetch. The
per-file email button is rate-limited to 3 sends per 5 minutes per report — the
CEO shouldn't get twenty copies because someone leaned on the button.
