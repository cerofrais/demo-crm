"use client";

/**
 * Demo routes for the features merged from main in October 2026: the Ask the
 * Database console, duplicate-lead merge, template folders, campaign tag
 * windows, and the call/line vocabularies the new filters read.
 *
 * Registered by api-router.ts alongside ext-routes.ts, so these share its
 * route table, envelope and most-specific-first matching.
 */
import { getDb, mutateDb, newId, nowIso } from "./store";
import { DEMO_USERS } from "./seed";
import { ensureExt, type DemoExt } from "./ext-seed";
import type { DemoData, DemoEnquiry } from "./types";
import type { ExtRouteApi } from "./ext-routes";

type Oct = NonNullable<DemoExt["oct"]>;

/** The October namespace, built on first touch (see DemoExt.oct). */
function ensureOct(e: DemoExt, db: DemoData): Oct {
  if (!e.oct) {
    const channels = ["whatsapp", "email"] as const;
    e.oct = {
      folders: channels.flatMap((channel) =>
        ["Onboarding", "Pricing", "Follow-up"].map((name) => ({
          id: newId("fold"),
          channel,
          name,
          parentId: null,
        })),
      ),
      scheduledTags: [],
      asked: [],
    };
    // File the seeded templates into the folder their name suggests, so the
    // folder tree opens with something in it rather than six empty folders.
    for (const t of db.messageTemplates) {
      const f = e.oct.folders.find(
        (x) =>
          x.channel === t.channel &&
          ((/welcome|booking/i.test(t.name) && x.name === "Onboarding") ||
            (/pricing|package|brochure/i.test(t.name) && x.name === "Pricing") ||
            (/follow|consult/i.test(t.name) && x.name === "Follow-up")),
      );
      if (f) t.folderId = f.id;
    }
  }
  return e.oct;
}

export function registerOctRoutes({ on, ok, currentUser }: ExtRouteApi) {
  const ext = () => ensureExt(getDb(), DEMO_USERS);
  const oct = () => ensureOct(ext(), getDb());
  const mutateOct = (fn: (o: Oct, db: DemoData) => void) =>
    mutateDb((db) => fn(ensureOct(ensureExt(db, DEMO_USERS), db), db));
  const live = (db: DemoData) => db.enquiries.filter((e) => !e.deletedAt);
  const guestOf = (db: DemoData, e: DemoEnquiry) => db.guests.find((g) => g.id === e.guestId);

  // ---- Vocabularies the new filters read ----------------------------------

  on("GET", "/api/calls/tags", () => {
    const db = getDb();
    const all = db.calls.flatMap((c) => [...(c.tags ?? []), ...(c.aiTags ?? [])]);
    return ok([...new Set(all)].sort((a, b) => a.localeCompare(b)));
  });

  /** Every WhatsApp line that has ever sent, current or not — the Activity
   *  page's line filter, which is wider than the connected-numbers list. */
  on("GET", "/api/reports/activity/numbers", () => {
    const db = getDb();
    const seen = new Map<string, string>();
    for (const n of db.whatsappNumbers) seen.set(n.instanceName, n.label);
    for (const m of db.messages) {
      if (m.channel === "whatsapp" && m.mailboxId && !seen.has(m.mailboxId)) {
        seen.set(m.mailboxId, m.fromLabel ?? m.mailboxId);
      }
    }
    return ok([...seen].map(([value, label]) => ({ value, label })));
  });

  // ---- Template folders ---------------------------------------------------

  const folderDTO = (f: Oct["folders"][number], db: DemoData) => ({
    ...f,
    // Direct children only — the tree adds up descendants itself.
    templateCount: db.messageTemplates.filter((t) => t.folderId === f.id && !t.archivedAt).length,
  });

  on("GET", "/api/message-templates/folders", ({ query }) => {
    const db = getDb();
    const channel = query.get("channel");
    const list = oct().folders.filter((f) => !channel || f.channel === channel);
    return ok(list.map((f) => folderDTO(f, db)));
  });

  on("POST", "/api/message-templates/folders", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (!name) throw new Error("A folder name is required.");
    const folder = {
      id: newId("fold"),
      channel: (b.channel === "email" ? "email" : "whatsapp") as "email" | "whatsapp",
      name,
      parentId: typeof b.parentId === "string" && b.parentId ? b.parentId : null,
    };
    mutateOct((o) => {
      o.folders.push(folder);
    });
    return ok(folderDTO(folder, getDb()));
  });

  on("PATCH", "/api/message-templates/folders/:id", ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    mutateOct((o) => {
      const f = o.folders.find((x) => x.id === params.id);
      if (!f) return;
      if (typeof b.name === "string" && b.name.trim()) f.name = b.name.trim();
      // A folder cannot be filed inside itself, which would orphan the branch.
      if ("parentId" in b && b.parentId !== params.id) {
        f.parentId = typeof b.parentId === "string" && b.parentId ? b.parentId : null;
      }
    });
    const f = oct().folders.find((x) => x.id === params.id);
    return ok(f ? folderDTO(f, getDb()) : null);
  });

  on("DELETE", "/api/message-templates/folders/:id", ({ params }) => {
    mutateOct((o, db) => {
      const gone = new Set<string>([params.id!]);
      // Delete the branch, not just the node, or its children become invisible.
      for (let grew = true; grew; ) {
        grew = false;
        for (const f of o.folders) {
          if (f.parentId && gone.has(f.parentId) && !gone.has(f.id)) {
            gone.add(f.id);
            grew = true;
          }
        }
      }
      o.folders = o.folders.filter((f) => !gone.has(f.id));
      // Templates outlive their folder — they fall back to unfiled.
      for (const t of db.messageTemplates) if (t.folderId && gone.has(t.folderId)) t.folderId = null;
    });
    return ok({ id: params.id, deleted: true });
  });

  // ---- Campaign tag windows ----------------------------------------------

  /** A window's state is derived from the clock, never stored — otherwise it
   *  goes stale the moment the demo sits idle. */
  const tagState = (r: Oct["scheduledTags"][number]) => {
    if (!r.enabled) return "off" as const;
    const now = Date.now();
    if (Date.parse(r.startsAt) > now) return "upcoming" as const;
    if (Date.parse(r.endsAt) < now) return "finished" as const;
    return "running" as const;
  };
  const tagDTO = (r: Oct["scheduledTags"][number]) => ({ ...r, state: tagState(r) });

  on("GET", "/api/whatsapp/scheduled-tags", () =>
    ok(
      [...oct().scheduledTags]
        .sort((a, b) => (a.startsAt < b.startsAt ? 1 : -1))
        .map(tagDTO),
    ),
  );

  on("POST", "/api/whatsapp/scheduled-tags", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const tag = String(b.tag ?? "").trim();
    const startsAt = String(b.startsAt ?? "");
    const endsAt = String(b.endsAt ?? "");
    if (!tag || !startsAt || !endsAt) throw new Error("A tag and both dates are required.");
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error("The window has to end after it starts.");
    const rule = {
      id: newId("sched"),
      numberId: String(b.numberId ?? ""),
      tag,
      label: typeof b.label === "string" && b.label.trim() ? b.label.trim() : null,
      startsAt,
      endsAt,
      enabled: true,
    };
    mutateOct((o) => {
      o.scheduledTags.push(rule);
    });
    return ok(tagDTO(rule));
  });

  on("PATCH", "/api/whatsapp/scheduled-tags/:id", ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    mutateOct((o) => {
      const r = o.scheduledTags.find((x) => x.id === params.id);
      if (!r) return;
      if (typeof b.enabled === "boolean") r.enabled = b.enabled;
      if (typeof b.tag === "string" && b.tag.trim()) r.tag = b.tag.trim();
      if (typeof b.startsAt === "string") r.startsAt = b.startsAt;
      if (typeof b.endsAt === "string") r.endsAt = b.endsAt;
    });
    const r = oct().scheduledTags.find((x) => x.id === params.id);
    return ok(r ? tagDTO(r) : null);
  });

  on("DELETE", "/api/whatsapp/scheduled-tags/:id", ({ params }) => {
    mutateOct((o) => {
      o.scheduledTags = o.scheduledTags.filter((x) => x.id !== params.id);
    });
    return ok({ id: params.id, deleted: true });
  });

  // ---- Merge a duplicate lead into another --------------------------------

  /** What moving `from` into `target` would carry across — shown before the
   *  merge is confirmed, so nobody is guessing at what they are about to do. */
  on("GET", "/api/enquiries/:id/merge", ({ params, query }) => {
    const db = getDb();
    const from = query.get("from");
    const src = db.enquiries.find((e) => e.id === from);
    const target = db.enquiries.find((e) => e.id === params.id);
    if (!src || !target) throw new Error("Lead not found");
    const srcGuest = guestOf(db, src);
    const tgtGuest = guestOf(db, target);
    // Fields the target is missing that the duplicate can fill in.
    const guestFields: string[] = [];
    if (srcGuest && tgtGuest && srcGuest.id !== tgtGuest.id) {
      const pairs: [string, unknown, unknown][] = [
        ["email", tgtGuest.email, srcGuest.email],
        ["phone", tgtGuest.phone, srcGuest.phone],
        ["city", tgtGuest.city, srcGuest.city],
        ["gender", tgtGuest.gender, srcGuest.gender],
      ];
      for (const [name, mine, theirs] of pairs) if (!mine && theirs) guestFields.push(name);
    }
    return ok({
      messages: db.messages.filter((m) => m.enquiryId === src.id).length,
      calls: db.calls.filter((c) => c.enquiryId === src.id).length,
      notes: db.notes.filter((n) => n.enquiryId === src.id).length,
      tasks: db.tasks.filter((t) => t.enquiryId === src.id).length,
      documents: db.documents.filter((d) => d.enquiryId === src.id).length,
      guestFields,
      sameGuest: srcGuest?.id === tgtGuest?.id,
    });
  });

  on("POST", "/api/enquiries/:id/merge", ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const sourceId = String(b.sourceEnquiryId ?? "");
    const me = currentUser();
    mutateDb((db) => {
      const src = db.enquiries.find((e) => e.id === sourceId);
      const target = db.enquiries.find((e) => e.id === params.id);
      if (!src || !target) return;
      // Everything the duplicate carried now hangs off the surviving lead.
      for (const m of db.messages) if (m.enquiryId === src.id) m.enquiryId = target.id;
      for (const c of db.calls) if (c.enquiryId === src.id) c.enquiryId = target.id;
      for (const n of db.notes) if (n.enquiryId === src.id) n.enquiryId = target.id;
      for (const t of db.tasks) if (t.enquiryId === src.id) t.enquiryId = target.id;
      for (const d of db.documents) if (d.enquiryId === src.id) d.enquiryId = target.id;
      for (const a of db.activities) if (a.enquiryId === src.id) a.enquiryId = target.id;
      target.tags = [...new Set([...target.tags, ...src.tags])];
      const sg = db.guests.find((g) => g.id === src.guestId);
      const tg = db.guests.find((g) => g.id === target.guestId);
      if (sg && tg && sg.id !== tg.id) {
        tg.email = tg.email ?? sg.email;
        tg.phone = tg.phone ?? sg.phone;
        tg.city = tg.city ?? sg.city;
        tg.gender = tg.gender ?? sg.gender;
      }
      // The duplicate is archived rather than destroyed, so the merge can be
      // undone and the audit trail still shows it existed.
      src.deletedAt = nowIso();
      target.lastActivityAt = nowIso();
      db.activities.push({
        id: newId("act"),
        enquiryId: target.id,
        guestId: target.guestId,
        actorSub: me.sub,
        actorRole: me.role,
        actorName: me.name,
        actionType: "merge",
        metadata: { from: src.id },
        createdAt: nowIso(),
      });
    });
    return ok({ id: params.id, mergeId: newId("merge"), merged: true });
  });

  // ---- Ask the Database ---------------------------------------------------
  registerAskDb({ on, ok, currentUser }, { oct: () => oct(), mutateOct, live, guestOf });
}

// ---------------------------------------------------------------------------
// Ask the Database
//
// The real console sends the question to a model, which writes SQL against a
// catalogued schema. There is no model and no Postgres in the browser, so the
// same questions are answered by rule over the demo store and handed back in
// the shape the console renders — including the SQL, which is written out so
// what the page shows is still "the answer, and the query behind it".
// ---------------------------------------------------------------------------

interface TimelineRow {
  ts: number;
  at: string;
  kind: "stage" | "message" | "call" | "note" | "task" | "event";
  who: string;
  detail: string;
}

const DAY = 86_400_000;
const MODEL = "gemma3:latest";

function registerAskDb(
  { on, ok, currentUser }: ExtRouteApi,
  h: {
    oct: () => Oct;
    mutateOct: (fn: (o: Oct, db: DemoData) => void) => void;
    live: (db: DemoData) => DemoEnquiry[];
    guestOf: (db: DemoData, e: DemoEnquiry) => { id: string; fullName: string } | undefined;
  },
) {
  const leadCard = (db: DemoData, e: DemoEnquiry) => {
    const g = db.guests.find((x) => x.id === e.guestId);
    return {
      enquiryId: e.id,
      guestId: e.guestId,
      name: g?.fullName ?? "Unknown guest",
      phone: g?.phone ?? null,
      city: g?.city ?? null,
      stage: e.stage,
      source: e.source,
      owner: e.assignedToName,
      campaignLabel: e.campaignLabel,
      tags: e.tags,
      createdAt: e.createdAt,
      lastActivityAt: e.lastActivityAt,
      deleted: Boolean(e.deletedAt),
    };
  };

  /** One lead's history, oldest first — the account the answer rests on. */
  const timelineFor = (db: DemoData, e: DemoEnquiry): TimelineRow[] => {
    const rows: TimelineRow[] = [];
    const push = (at: string, kind: TimelineRow["kind"], who: string, detail: string) =>
      rows.push({ ts: Date.parse(at), at, kind, who, detail });
    push(e.createdAt, "event", "System", `Lead created via ${e.source.replace(/_/g, " ")}.`);
    for (const a of db.activities.filter((x) => x.enquiryId === e.id)) {
      if (a.actionType === "stage_change") {
        push(a.createdAt, "stage", a.actorName, `Stage ${String(a.metadata.from)} → ${String(a.metadata.to)}.`);
      }
    }
    for (const m of db.messages.filter((x) => x.enquiryId === e.id && !x.deletedAt)) {
      push(
        m.createdAt,
        "message",
        m.direction === "inbound" ? "Guest" : m.fromLabel ?? "Staff",
        `${m.channel === "email" ? "Email" : "WhatsApp"} ${m.direction}: ${m.body.slice(0, 120)}`,
      );
    }
    for (const c of db.calls.filter((x) => x.enquiryId === e.id)) {
      push(
        c.startedAt,
        "call",
        c.repName ?? "Reception",
        `${c.direction} call, ${c.status}${c.durationSec ? `, ${Math.round(c.durationSec / 60)} min` : ""}.`,
      );
    }
    for (const n of db.notes.filter((x) => x.enquiryId === e.id)) push(n.createdAt, "note", n.authorName, n.body.slice(0, 160));
    for (const t of db.tasks.filter((x) => x.enquiryId === e.id)) push(t.createdAt, "task", "Follow-up", `${t.title} (${t.status}).`);
    return rows.sort((a, b) => a.ts - b.ts);
  };

  /** A plain-English account of the lead, built from what actually happened. */
  const narrate = (db: DemoData, e: DemoEnquiry, tl: TimelineRow[]) => {
    const g = db.guests.find((x) => x.id === e.guestId);
    const inbound = tl.filter((r) => r.kind === "message" && r.who === "Guest").length;
    const outbound = tl.filter((r) => r.kind === "message" && r.who !== "Guest").length;
    const calls = tl.filter((r) => r.kind === "call").length;
    const last = tl[tl.length - 1];
    const days = Math.max(0, Math.round((Date.now() - Date.parse(e.lastActivityAt)) / DAY));
    const bits = [
      `${g?.fullName ?? "This guest"} came in via ${e.source.replace(/_/g, " ")}${e.campaignLabel ? ` on the ${e.campaignLabel} campaign` : ""} on ${e.createdAt.slice(0, 10)}, and is now at ${e.stage.replace(/_/g, " ")}.`,
      e.assignedToName ? `${e.assignedToName} owns the lead.` : "Nobody owns the lead yet.",
      `There have been ${outbound} message${outbound === 1 ? "" : "s"} out and ${inbound} back${calls ? `, plus ${calls} call${calls === 1 ? "" : "s"}` : ""}.`,
      last ? `The last thing on the record is ${last.at.slice(0, 10)} — ${last.detail.slice(0, 120)}` : "",
      days > 14 ? `Nothing has moved for ${days} days, which is the thing worth acting on.` : "",
    ];
    return bits.filter(Boolean).join(" ");
  };

  /** Pattern-matched answers for the kinds of question the console advertises. */
  function sqlAnswer(db: DemoData, q: string): { sql: string; explanation: string; columns: string[]; rows: Record<string, unknown>[] } {
    const lower = q.toLowerCase();
    const leads = h.live(db);
    const now = Date.now();
    const since = (d: number) => new Date(now - d * DAY).toISOString();
    const ownerOf = (e: DemoEnquiry) => e.assignedToName ?? "Unassigned";

    // "messages sent from the 61 number in the last 10 days"
    const numberAsk = lower.match(/(?:from (?:the )?)(\d{2,})\s*(?:number|line)/);
    if (numberAsk && /message/.test(lower)) {
      const frag = numberAsk[1]!;
      const line = db.whatsappNumbers.find((n) => (n.phoneNumber ?? "").replace(/\D/g, "").endsWith(frag));
      const days = Number(lower.match(/last (\d+) days?/)?.[1] ?? 10);
      const from = since(days);
      const rows = db.messages
        .filter((m) => m.channel === "whatsapp" && m.direction === "outbound" && m.createdAt >= from)
        .filter((m) => !line || m.mailboxId === line.instanceName)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 50)
        .map((m) => ({
          sent_at: m.createdAt.slice(0, 16).replace("T", " "),
          line: m.fromLabel ?? m.mailboxId,
          guest: db.guests.find((g) => g.id === m.guestId)?.fullName ?? "—",
          body: m.body.slice(0, 80),
        }));
      return {
        sql: `SELECT m."createdAt" AS sent_at, m."fromEmail" AS line, g."fullName" AS guest, left(m.body, 80) AS body\nFROM "Message" m JOIN "Guest" g ON g.id = m."guestId"\nWHERE m.channel = 'whatsapp' AND m.direction = 'outbound'\n  AND m."fromEmail" LIKE '%${frag}'\n  AND m."createdAt" >= now() - interval '${days} days'\nORDER BY m."createdAt" DESC;`,
        explanation: `Outbound WhatsApp on the ${frag} line over the last ${days} days. The line a message went out on is kept in Message.fromEmail.`,
        columns: ["sent_at", "line", "guest", "body"],
        rows,
      };
    }

    // "how many new leads came in from the google sheets last week"
    if (/google ?sheet/.test(lower)) {
      const from = since(/last week/.test(lower) ? 14 : 30);
      const rows = leads
        .filter((e) => e.source === "google_sheets" && e.createdAt >= from)
        .reduce<Record<string, number>>((acc, e) => {
          const d = e.createdAt.slice(0, 10);
          acc[d] = (acc[d] ?? 0) + 1;
          return acc;
        }, {});
      return {
        sql: `SELECT date_trunc('day', "createdAt") AS day, count(*) AS leads\nFROM "Enquiry"\nWHERE source = 'google_sheets' AND "deletedAt" IS NULL\n  AND "createdAt" >= now() - interval '14 days'\nGROUP BY 1 ORDER BY 1;`,
        explanation: "New leads whose source is the Google Sheets intake, by day. Deleted leads are excluded — a soft delete is a row with deletedAt set.",
        columns: ["day", "leads"],
        rows: Object.entries(rows).sort().map(([day, n]) => ({ day, leads: n })),
      };
    }

    // "how many leads did each rep convert this month"
    if (/each rep|per rep|by rep|each owner/.test(lower)) {
      const converted = /convert/.test(lower);
      // The demo's history is a rolling 30 days, so a calendar-month window
      // would answer "nothing yet" for anyone opening this on the 2nd. The
      // window actually used is named in the explanation and the SQL below,
      // so what the page claims and what it computed are the same thing.
      const from = since(30);
      const acc: Record<string, number> = {};
      for (const e of leads) {
        if (converted && e.stage !== "converted") continue;
        if (e.lastActivityAt < from) continue;
        acc[ownerOf(e)] = (acc[ownerOf(e)] ?? 0) + 1;
      }
      return {
        sql: `SELECT "assignedToName" AS rep, count(*) AS ${converted ? "converted" : "leads"}\nFROM "Enquiry"\nWHERE "deletedAt" IS NULL${converted ? `\n  AND stage = 'converted'` : ""}\n  AND "lastActivityAt" >= now() - interval '30 days'\nGROUP BY 1 ORDER BY 2 DESC;`,
        explanation: `${converted ? "Conversions" : "Leads worked"} over the last 30 days, by the rep the lead is assigned to.`,
        columns: ["rep", converted ? "converted" : "leads"],
        rows: Object.entries(acc)
          .sort((a, b) => b[1] - a[1])
          .map(([rep, n]) => ({ rep, [converted ? "converted" : "leads"]: n })),
      };
    }

    // "which leads are in payment received but have no call in the last 7 days"
    if (/payment received/.test(lower) && /no call|without a call/.test(lower)) {
      const days = Number(lower.match(/last (\d+) days?/)?.[1] ?? 7);
      const from = since(days);
      const rows = leads
        .filter((e) => e.stage === "payment_received")
        .filter((e) => !db.calls.some((c) => c.enquiryId === e.id && c.startedAt >= from))
        .map((e) => ({
          lead: h.guestOf(db, e)?.fullName ?? "—",
          owner: ownerOf(e),
          since: e.lastActivityAt.slice(0, 10),
          quoted: e.quotedPriceINR ?? "—",
        }));
      return {
        sql: `SELECT g."fullName" AS lead, e."assignedToName" AS owner, e."lastActivityAt"::date AS since, e."quotedPriceINR" AS quoted\nFROM "Enquiry" e JOIN "Guest" g ON g.id = e."guestId"\nWHERE e.stage = 'payment_received' AND e."deletedAt" IS NULL\n  AND NOT EXISTS (\n    SELECT 1 FROM "Call" c\n    WHERE c."enquiryId" = e.id AND c."startedAt" >= now() - interval '${days} days'\n  )\nORDER BY e."lastActivityAt";`,
        explanation: `Leads sitting at Payment Pending that nobody has called in ${days} days — the ones most likely to go quiet after paying.`,
        columns: ["lead", "owner", "since", "quoted"],
        rows,
      };
    }

    // "calls longer than 5 minutes this week with their AI summary"
    const longCall = lower.match(/longer than (\d+) ?min/);
    if (longCall || (/call/.test(lower) && /summary/.test(lower))) {
      const mins = Number(longCall?.[1] ?? 5);
      const from = since(/this week/.test(lower) ? 7 : 30);
      const rows = db.calls
        .filter((c) => c.durationSec > mins * 60 && c.startedAt >= from)
        .sort((a, b) => b.durationSec - a.durationSec)
        .slice(0, 25)
        .map((c) => ({
          guest: c.guestName,
          rep: c.repName ?? "—",
          minutes: Math.round(c.durationSec / 60),
          score: c.aiScore ?? "—",
          summary: (c.aiSummary ?? "Not analysed yet").slice(0, 90),
        }));
      return {
        sql: `SELECT g."fullName" AS guest, c."repName" AS rep, round(c."durationSec"/60.0) AS minutes, c."aiScore" AS score, left(c."aiSummary", 90) AS summary\nFROM "Call" c JOIN "Guest" g ON g.id = c."guestId"\nWHERE c."durationSec" > ${mins * 60}\n  AND c."startedAt" >= now() - interval '7 days'\nORDER BY c."durationSec" DESC;`,
        explanation: `Calls over ${mins} minutes in the last week, with the summary the call analysis wrote.`,
        columns: ["guest", "rep", "minutes", "score", "summary"],
        rows,
      };
    }

    // "how many WhatsApp messages did we send each day this month"
    if (/each day|per day|by day/.test(lower)) {
      const channel = /email/.test(lower) ? "email" : "whatsapp";
      const from = since(30);
      const acc: Record<string, number> = {};
      for (const m of db.messages) {
        if (m.channel !== channel || m.direction !== "outbound" || m.createdAt < from) continue;
        const d = m.createdAt.slice(0, 10);
        acc[d] = (acc[d] ?? 0) + 1;
      }
      return {
        sql: `SELECT date_trunc('day', "createdAt" AT TIME ZONE 'Asia/Kolkata') AS day, count(*) AS sent\nFROM "Message"\nWHERE channel = '${channel}' AND direction = 'outbound'\n  AND "createdAt" >= now() - interval '30 days'\nGROUP BY 1 ORDER BY 1;`,
        explanation: `Outbound ${channel === "email" ? "email" : "WhatsApp"} per day over the last 30 days. Timestamps are UTC; the day is bucketed in IST, which is the working day staff mean.`,
        columns: ["day", "sent"],
        rows: Object.entries(acc).sort().map(([day, n]) => ({ day, sent: n })),
      };
    }

    // Anything else: the shape of the pipeline, which is the question most
    // often meant by a vague one.
    const bySource = /source/.test(lower);
    const key = (e: DemoEnquiry) => (bySource ? e.source.replace(/_/g, " ") : e.stage.replace(/_/g, " "));
    const acc: Record<string, number> = {};
    for (const e of leads) acc[key(e)] = (acc[key(e)] ?? 0) + 1;
    return {
      sql: `SELECT ${bySource ? "source" : "stage"}, count(*) AS leads\nFROM "Enquiry"\nWHERE "deletedAt" IS NULL\nGROUP BY 1 ORDER BY 2 DESC;`,
      explanation: `Open leads grouped by ${bySource ? "where they came from" : "the stage they are sitting in"}.`,
      columns: [bySource ? "source" : "stage", "leads"],
      rows: Object.entries(acc)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => ({ [bySource ? "source" : "stage"]: k, leads: n })),
    };
  }

  on("POST", "/api/admin/ask-db", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const question = String(b.question ?? "").trim();
    const me = currentUser();
    const db = getDb();
    const t0 = Date.now();
    if (!question) throw new Error("Ask a question first.");

    const record = (ok_: boolean, mode: "sql" | "lead" | null, sql: string | null, answer: unknown) => {
      const id = newId("ask");
      h.mutateOct((o) => {
        o.asked.unshift({ id, question, at: nowIso(), ok: ok_, mode, by: me.name, bySub: me.sub, sql, answer });
        o.asked = o.asked.slice(0, 40);
      });
      return id;
    };

    // A question that names a guest is about that lead, not about the business.
    const explicit = typeof b.enquiryId === "string" ? db.enquiries.find((e) => e.id === b.enquiryId) : undefined;
    // The question and the name are reduced the same way before they are
    // compared — otherwise "Pooja D'Souza" never matches a question that has
    // already had its punctuation stripped.
    const tokens = (v: string) =>
      v
        .toLowerCase()
        .replace(/[^\p{L}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);
    const words = new Set(tokens(question));
    const named = explicit
      ? [explicit]
      : db.enquiries.filter((e) => {
          const parts = tokens(db.guests.find((g) => g.id === e.guestId)?.fullName ?? "");
          if (!parts.length) return false;
          const hits = parts.filter((p) => words.has(p)).length;
          // Two names, or a single distinctive one — "Seema Rani" or "Chowdhury",
          // but never a lead matched on a first name as common as "Sai".
          return hits >= 2 || (parts.length === 1 && hits === 1 && parts[0]!.length >= 5);
        });

    if (named.length > 1) {
      const name = db.guests.find((g) => g.id === named[0]!.guestId)?.fullName ?? question;
      const answer = {
        ok: false as const,
        mode: "choose" as const,
        question,
        name,
        candidates: named.slice(0, 8).map((e) => leadCard(db, e)),
        error: `${named.length} leads match that name — pick the one you meant.`,
      };
      record(false, null, null, null);
      return ok(answer);
    }

    if (named.length === 1) {
      const e = named[0]!;
      const tl = timelineFor(db, e);
      // The evidence is the tail of the account — what the answer leans on.
      const evidence = tl.slice(-6).map((r, i) => ({ ...r, n: i + 1 }));
      const answer = {
        ok: true as const,
        mode: "lead" as const,
        question,
        answer: narrate(db, e, tl),
        lead: leadCard(db, e),
        evidence,
        timeline: tl,
        model: MODEL,
        generationMs: Date.now() - t0 + 180,
      };
      record(true, "lead", null, {
        mode: "lead",
        answer: answer.answer,
        lead: { enquiryId: e.id, name: answer.lead.name, stage: e.stage },
        evidence,
      });
      return ok(answer);
    }

    const res = sqlAnswer(db, question);
    const trimmed = res.rows.length > 200;
    const answer = {
      ok: true as const,
      mode: "sql" as const,
      question,
      sql: typeof b.sql === "string" && b.sql.trim() ? b.sql : res.sql,
      explanation: res.explanation,
      result: {
        columns: res.columns,
        rows: res.rows.slice(0, 200),
        rowCount: res.rows.length,
        truncated: trimmed,
        durationMs: Date.now() - t0 + 12,
      },
      attempts: 1,
      model: MODEL,
      generationMs: Date.now() - t0 + 240,
    };
    record(true, "sql", answer.sql, {
      mode: "sql",
      explanation: res.explanation,
      columns: res.columns,
      rows: res.rows.slice(0, 50),
      rowCount: res.rows.length,
      rowsTrimmed: res.rows.length > 50,
    });
    return ok(answer);
  });

  on("GET", "/api/admin/ask-db/history", () => {
    const me = currentUser();
    return ok(
      h.oct().asked.map((a) => ({
        id: a.id,
        question: a.question,
        at: a.at,
        ok: a.ok,
        mode: a.mode,
        by: a.by,
        mine: a.bySub === me.sub,
        hasAnswer: a.answer !== null,
      })),
    );
  });

  on("GET", "/api/admin/ask-db/history/:id", ({ params }) => {
    const a = h.oct().asked.find((x) => x.id === params.id);
    if (!a || !a.answer) throw new Error("That answer was not kept.");
    return ok({ id: a.id, question: a.question, sql: a.sql, askedAt: a.at, askedBy: a.by, answer: a.answer });
  });
}

// ---------------------------------------------------------------------------
// Responses that aren't JSON, so the interceptor serves them directly
// ---------------------------------------------------------------------------

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The guest CSV the Guests page downloads for a selection. */
export function demoGuestCsv(guestIds: string[]): string {
  const db = getDb();
  const wanted = new Set(guestIds);
  const rows = [["Name", "Phone", "Email", "City", "Tags", "Returning", "Created"]];
  for (const g of db.guests.filter((x) => wanted.has(x.id))) {
    rows.push([
      g.fullName,
      g.phone ?? "",
      g.email ?? "",
      g.city ?? "",
      (g.tags ?? []).join(" | "),
      g.isReturning ? "yes" : "no",
      g.createdAt.slice(0, 10),
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

/**
 * The tidied remark the AI drafter returns. The real one rewrites what the rep
 * typed and folds in anything it read from a photo or voice note; here the
 * typed text is cleaned up and the same sources are acknowledged, so the
 * composer behaves the way it does in production.
 */
export function demoRemarkDraft(typed: string, isAudio: boolean, isImage: boolean): string {
  const base = typed.replace(/\s+/g, " ").trim();
  const sentence = base ? base[0]!.toUpperCase() + base.slice(1) : "";
  const tail = sentence && !/[.!?]$/.test(sentence) ? "." : "";
  const extras = [
    isAudio ? "Guest asked on a voice note whether the November dates are still open, and what the deposit would be." : "",
    isImage ? "Shared a photo of the prescription for the doctor to review before confirming the programme." : "",
  ].filter(Boolean);
  return [sentence + tail, ...extras].filter(Boolean).join(" ") || "Spoke to the guest; nothing further to add yet.";
}

/**
 * The Cresent report's "Download audios" link asks for a zip of the call
 * recordings. There are no recordings to bundle in a browser-only build and
 * no zip writer in the bundle, so the link hands back the index that zip
 * would have carried — and says plainly why the audio isn't in it, rather
 * than letting the click fall through to a backend that isn't there.
 */
export function demoRecordingIndex(href: string): { filename: string; text: string; mime: string } | null {
  const u = new URL(href, "http://demo.local");
  if (u.pathname.replace(/\/$/, "") !== "/api/reports/cresent/audio") return null;
  const from = u.searchParams.get("from") ?? "";
  const to = u.searchParams.get("to") ?? "";
  const db = getDb();
  const inRange = (iso: string) => (!from || iso >= from) && (!to || iso <= `${to}T23:59:59.999Z`);
  const rows = [["Guest", "Rep", "Started", "Minutes", "Recording"]];
  for (const c of db.calls.filter((x) => x.recordingUrl && inRange(x.startedAt))) {
    rows.push([
      c.guestName,
      c.repName ?? "",
      c.startedAt.slice(0, 16).replace("T", " "),
      String(Math.round(c.durationSec / 60)),
      `${c.guestName.replace(/\s+/g, "-").toLowerCase()}-${c.id}.mp3`,
    ]);
  }
  const note =
    "# Call recordings are not bundled in this browser demo — the audio lives on the\n" +
    "# client's own server. This is the index the zip would have carried.\n";
  return {
    filename: `cresent-recordings-${from || "all"}-to-${to || "all"}.csv`,
    text: note + rows.map((r) => r.map(csvCell).join(",")).join("\n"),
    mime: "text/csv",
  };
}
