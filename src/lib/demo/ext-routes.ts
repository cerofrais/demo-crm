"use client";

/**
 * Demo routes for the features merged from main in September 2026. Registered
 * by api-router.ts once its helpers exist (see registerExtRoutes there), so
 * they share its route table, envelope and most-specific-first matching.
 *
 * Every handler returns the same shape the real route does, so the pages
 * render exactly as they do in production.
 */
import { getDb, mutateDb, newId, nowIso } from "./store";
import { DEMO_USERS } from "./seed";
import { ensureExt, type DemoExt, type DemoSheetRun, type DemoSheetSummary } from "./ext-seed";
import type { DemoData, DemoEnquiry, EnquiryStage } from "./types";
import { mergeLeadTags, slugifyTag } from "../lead-tags";
import {
  addDays,
  addWeeks,
  buildTouches,
  CSV_HEADERS,
  csvRows,
  callContact,
  groupByDay,
  istWeekStart,
  isWeekStart,
  isYmd,
  matchingTags,
  MAX_RANGE_DAYS,
  messageContact,
  rangeDays,
  type CresentLeadDTO,
  type RawContact,
} from "../cresent-report-shape";

type Ctx = { params: Record<string, string>; query: URLSearchParams; body: unknown };
type Result = { status: number; data: unknown; meta?: Record<string, unknown>; raw?: boolean };
type Handler = (ctx: Ctx) => Result | Promise<Result>;

export interface ExtRouteApi {
  on: (method: string, pattern: string, handler: Handler) => void;
  ok: (data: unknown, status?: number, extra?: { meta?: Record<string, unknown>; raw?: boolean }) => Result;
  currentUser: () => (typeof DEMO_USERS)[number];
}

const HOUR = 3_600_000;
const IST = 5.5 * HOUR;
const istDayOf = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const terms = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.map((t) => String(t).trim()).filter(Boolean))] : [];

function ext(): DemoExt {
  return ensureExt(getDb(), DEMO_USERS);
}
function mutateExt(fn: (e: DemoExt, db: DemoData) => void) {
  mutateDb((db) => fn(ensureExt(db, DEMO_USERS), db));
}
function err(status: number, message: string): Result {
  // The real API's error envelope; lib/client.ts surfaces `error.message`.
  return { status, data: undefined, meta: { error: { code: "DEMO_VALIDATION", message } } };
}

export function registerExtRoutes({ on, ok, currentUser }: ExtRouteApi) {
  // ---- Email: footer, auto-replies, auto-tags, welcome ---------------------

  on("GET", "/api/admin/email-footer", () => ok(ext().emailFooter));
  on("PUT", "/api/admin/email-footer", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    mutateExt((e) => {
      e.emailFooter = { enabled: b.enabled !== false, html: str(b.html), text: str(b.text), updatedAt: nowIso() };
    });
    return ok(ext().emailFooter);
  });

  on("GET", "/api/admin/email-autoreplies", () => ok({ items: ext().emailAutoReplies }));
  on("POST", "/api/admin/email-autoreplies", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const row = {
      id: newId("ear"),
      mailboxId: str(b.mailboxId) || "sales",
      subjectTerms: terms(b.subjectTerms),
      bodyTerms: terms(b.bodyTerms),
      termMatch: (b.termMatch === "all" ? "all" : "any") as "any" | "all",
      subject: str(b.subject) || null,
      replyText: str(b.replyText),
      attachmentDocumentIds: (b.attachmentDocumentIds as string[]) ?? [],
      attachments: [],
      tagOnMatch: str(b.tagOnMatch) || null,
      enabled: true,
      activeFromMin: null,
      activeToMin: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    mutateExt((e) => e.emailAutoReplies.push(row));
    return ok(row, 201);
  });
  on("PATCH", "/api/admin/email-autoreplies/:id", ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    mutateExt((e) => {
      const r = e.emailAutoReplies.find((x) => x.id === params.id);
      if (r) Object.assign(r, b, { updatedAt: nowIso() });
    });
    return ok(ext().emailAutoReplies.find((x) => x.id === params.id) ?? null);
  });
  on("DELETE", "/api/admin/email-autoreplies/:id", ({ params }) => {
    mutateExt((e) => (e.emailAutoReplies = e.emailAutoReplies.filter((x) => x.id !== params.id)));
    return ok({ id: params.id, deleted: true });
  });

  on("GET", "/api/admin/email-autotags", () => ok({ items: ext().emailAutoTags }));
  on("POST", "/api/admin/email-autotags", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const subjectTerms = terms(b.subjectTerms);
    const bodyTerms = terms(b.bodyTerms);
    if (!subjectTerms.length && !bodyTerms.length) return err(400, "Add at least one word to match in the subject or body");
    const row = {
      id: newId("eat"),
      mailboxId: str(b.mailboxId) || "sales",
      subjectTerms,
      bodyTerms,
      termMatch: (b.termMatch === "all" ? "all" : "any") as "any" | "all",
      tag: slugifyTag(str(b.tag)),
      enabled: true,
      createdAt: nowIso(),
    };
    mutateExt((e) => e.emailAutoTags.push(row));
    return ok(row, 201);
  });
  on("PATCH", "/api/admin/email-autotags/:id", ({ params, body }) => {
    mutateExt((e) => {
      const r = e.emailAutoTags.find((x) => x.id === params.id);
      if (r) Object.assign(r, body as object);
    });
    return ok(ext().emailAutoTags.find((x) => x.id === params.id) ?? null);
  });
  on("DELETE", "/api/admin/email-autotags/:id", ({ params }) => {
    mutateExt((e) => (e.emailAutoTags = e.emailAutoTags.filter((x) => x.id !== params.id)));
    return ok({ id: params.id, deleted: true });
  });

  on("GET", "/api/email-welcome", () => ok(ext().welcomeEmail));
  on("PUT", "/api/email-welcome", ({ body }) => {
    mutateExt((e) => Object.assign(e.welcomeEmail, body as object));
    return ok(ext().welcomeEmail);
  });

  // ---- WhatsApp auto-tags ---------------------------------------------------

  on("GET", "/api/whatsapp/autotags", () => ok(ext().waAutoTags));
  on("POST", "/api/whatsapp/autotags", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const row = { id: newId("wat"), numberId: str(b.numberId), trigger: str(b.trigger).trim(), tag: slugifyTag(str(b.tag)), enabled: true, createdAt: nowIso() };
    mutateExt((e) => e.waAutoTags.push(row));
    return ok(row, 201);
  });
  on("PATCH", "/api/whatsapp/autotags/:id", ({ params, body }) => {
    mutateExt((e) => {
      const r = e.waAutoTags.find((x) => x.id === params.id);
      if (r) Object.assign(r, body as object);
    });
    return ok(ext().waAutoTags.find((x) => x.id === params.id) ?? null);
  });
  on("DELETE", "/api/whatsapp/autotags/:id", ({ params }) => {
    mutateExt((e) => (e.waAutoTags = e.waAutoTags.filter((x) => x.id !== params.id)));
    return ok({ id: params.id });
  });

  // ---- Lead assignment: tag rules, WhatsApp-line rules, shifts -------------

  on("GET", "/api/admin/lead-assignment/tags", () => {
    const db = getDb();
    const knownTags = [...new Set(db.enquiries.flatMap((e) => e.tags).concat(["foreign", "revisit"]))].sort();
    return ok({ rules: ext().tagRules, knownTags });
  });
  on("PUT", "/api/admin/lead-assignment/tags", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const tag = slugifyTag(str(b.label) || str(b.tag));
    mutateExt((e) => {
      const rule = {
        tag,
        label: str(b.label) || tag,
        strategy: (b.strategy === "least_busy" ? "least_busy" : "round_robin") as "round_robin" | "least_busy",
        eligibleSubs: (b.eligibleSubs as string[]) ?? [],
        priority: Number(b.priority ?? 0),
      };
      const i = e.tagRules.findIndex((r) => r.tag === tag);
      if (!rule.eligibleSubs.length) e.tagRules = e.tagRules.filter((r) => r.tag !== tag);
      else if (i >= 0) e.tagRules[i] = rule;
      else e.tagRules.push(rule);
    });
    return ok({ rules: ext().tagRules });
  });

  on("GET", "/api/admin/lead-assignment/whatsapp-numbers", () => {
    const knownNumbers = getDb()
      .whatsappNumbers.filter((n) => n.phoneNumber)
      .map((n) => ({ ourNumber: n.phoneNumber!, label: n.label, integration: n.integration, status: n.status }));
    return ok({ rules: ext().numberRules, knownNumbers });
  });
  on("PUT", "/api/admin/lead-assignment/whatsapp-numbers", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    mutateExt((e) => {
      const rule = {
        ourNumber: str(b.ourNumber),
        label: str(b.label),
        strategy: (b.strategy === "least_busy" ? "least_busy" : "round_robin") as "round_robin" | "least_busy",
        eligibleSubs: (b.eligibleSubs as string[]) ?? [],
      };
      const i = e.numberRules.findIndex((r) => r.ourNumber === rule.ourNumber);
      if (!rule.eligibleSubs.length) e.numberRules = e.numberRules.filter((r) => r.ourNumber !== rule.ourNumber);
      else if (i >= 0) e.numberRules[i] = rule;
      else e.numberRules.push(rule);
    });
    return ok({ rules: ext().numberRules });
  });

  on("GET", "/api/admin/staff-availability", () => {
    const now = new Date(Date.now() + IST);
    const today = now.toISOString().slice(0, 10);
    const weekday = now.getUTCDay();
    const hhmm = now.toISOString().slice(11, 16);
    const avail = ext().availability;
    const staff = DEMO_USERS.filter((u) => avail[u.sub]).map((u) => {
      const a = avail[u.sub]!;
      const offToday = a.weeklyOffDays.includes(weekday);
      const onLeaveToday = a.leave.some((l) => l.startDate <= today && today <= l.endDate);
      const shift = a.shifts.find((s) => s.weekday === weekday);
      const onShiftNow = !offToday && !onLeaveToday && !!shift && shift.start <= hhmm && hhmm < shift.end;
      return { sub: u.sub, name: u.name, role: u.role, isOnline: u.isOnline, weeklyOffDays: a.weeklyOffDays, shifts: a.shifts, onShiftNow, offToday, onLeaveToday, leave: a.leave };
    });
    return ok({ today: { date: today, weekday }, staff });
  });
  on("PUT", "/api/admin/staff-availability", ({ body }) => {
    const b = (body ?? {}) as { sub?: string; weeklyOffDays?: number[] };
    mutateExt((e) => {
      const a = b.sub ? e.availability[b.sub] : undefined;
      if (a && Array.isArray(b.weeklyOffDays)) a.weeklyOffDays = b.weeklyOffDays;
    });
    return ok({ ok: true });
  });
  on("PATCH", "/api/admin/staff-availability", ({ body }) => {
    const b = (body ?? {}) as { sub?: string; weekday?: number; start?: string; end?: string };
    mutateExt((e) => {
      const a = b.sub ? e.availability[b.sub] : undefined;
      if (!a || typeof b.weekday !== "number") return;
      a.shifts = a.shifts.filter((s) => s.weekday !== b.weekday);
      if (b.start && b.end) a.shifts.push({ weekday: b.weekday, start: b.start, end: b.end });
      a.shifts.sort((x, y) => x.weekday - y.weekday);
    });
    return ok({ ok: true });
  });
  on("POST", "/api/admin/staff-availability", ({ body }) => {
    const b = (body ?? {}) as { sub?: string; startDate?: string; endDate?: string; note?: string };
    mutateExt((e) => {
      const a = b.sub ? e.availability[b.sub] : undefined;
      if (a && b.startDate && b.endDate) a.leave.push({ id: newId("leave"), startDate: b.startDate, endDate: b.endDate, note: b.note ?? null });
    });
    return ok({ ok: true }, 201);
  });
  on("DELETE", "/api/admin/staff-availability", ({ query }) => {
    const id = query.get("leaveId");
    mutateExt((e) => {
      for (const a of Object.values(e.availability)) a.leave = a.leave.filter((l) => l.id !== id);
    });
    return ok({ ok: true });
  });

  // ---- Users: WhatsApp lines, activity monitor, sign-out -------------------

  on("GET", "/api/admin/users/whatsapp-lines", () =>
    ok(
      getDb()
        .whatsappNumbers.filter((n) => n.phoneNumber)
        .map((n) => ({ phoneNumber: n.phoneNumber!, label: n.label, connected: n.status === "connected", integration: n.integration })),
    ),
  );

  on("GET", "/api/users/activity-monitor", ({ query }) => {
    const day = query.get("day") ?? istDayOf(new Date());
    return ok(activityMonitor(day));
  });

  on("GET", "/api/auth/federated-logout", ({ query }) =>
    // No identity provider to sign out of — the demo just returns to /login.
    ok({ url: query.get("redirectTo") ?? "/login" }, 200, { raw: true }),
  );

  // ---- Health records (one per form) ---------------------------------------

  on("GET", "/api/health/records", ({ query }) => {
    const q = (query.get("q") ?? "").trim().toLowerCase();
    const db = getDb();
    const items = ext()
      .healthRecords.map((r) => {
        const g = db.guests.find((x) => x.id === r.guestId);
        return {
          recordId: r.id,
          guestId: r.guestId,
          name: r.subjectName ?? g?.fullName ?? "Guest",
          phone: g?.phone ?? "",
          guestName: g?.fullName ?? "",
          hasDuplicate: r.hasDuplicate,
          updatedAt: r.updatedAt,
        };
      })
      .filter((r) => !q || `${r.name} ${r.phone} ${r.guestName}`.toLowerCase().includes(q))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return ok({ items });
  });

  // ---- Guests, broadcasts, tasks, files ------------------------------------

  on("POST", "/api/guests/bulk-remove-tag", ({ body }) => {
    const b = (body ?? {}) as { guestIds?: string[]; tags?: string[] };
    let updated = 0;
    mutateDb((db) => {
      for (const g of db.guests.filter((x) => b.guestIds?.includes(x.id))) {
        const before = g.tags.length;
        g.tags = g.tags.filter((t) => !b.tags?.includes(t));
        if (g.tags.length !== before) updated += 1;
      }
    });
    return ok({ updated });
  });

  on("GET", "/api/broadcast-status/:id/followup-audience", ({ params }) => {
    const job = getDb().broadcastJobs.find((j) => j.id === params.id);
    const targeted = job?.sentCount ?? 0;
    const engaged = Math.round(targeted * 0.18);
    return ok({ targeted, engaged, awaitingReply: Math.round(engaged * 0.4), recipients: Math.max(0, engaged - Math.round(engaged * 0.4)) });
  });

  on("GET", "/api/tasks/tags", () => {
    const db = getDb();
    const withTasks = new Set(db.tasks.map((t) => t.enquiryId));
    return ok([...new Set(db.enquiries.filter((e) => withTasks.has(e.id)).flatMap((e) => e.tags))].sort());
  });

  on("DELETE", "/api/files/:id", ({ params }) => {
    mutateDb((db) => (db.documents = db.documents.filter((d) => d.id !== params.id)));
    return ok({ id: params.id, deleted: true });
  });

  // ---- Weekly client report (Cresent) --------------------------------------

  on("GET", "/api/reports/cresent/settings", () => ok({ settings: ext().cresent.settings, sends: ext().cresent.sends, sendHourIst: 9 }));
  on("PUT", "/api/reports/cresent/settings", ({ body }) => {
    const b = (body ?? {}) as { enabled?: boolean; recipients?: string[]; tags?: string[] };
    if (b.enabled && (!b.recipients?.length || !b.tags?.length)) {
      return err(400, "Add at least one email address and one tag before turning the weekly email on");
    }
    mutateExt((e) => {
      e.cresent.settings = { enabled: !!b.enabled, recipients: b.recipients ?? [], tags: b.tags ?? [], updatedAt: nowIso() };
    });
    return ok(ext().cresent.settings);
  });
  on("GET", "/api/reports/cresent", ({ query }) => {
    const range = parseRange(query);
    if ("error" in range) return err(400, range.error);
    const tags = query.has("tags")
      ? (query.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean)
      : ext().cresent.settings.tags;
    return ok(cresentReport(range, tags));
  });
  on("POST", "/api/reports/cresent/send", ({ body }) => {
    const b = (body ?? {}) as Record<string, string>;
    const range = parseRange(new URLSearchParams(b));
    if ("error" in range) return err(400, range.error);
    const s = ext().cresent.settings;
    if (!s.recipients.length) return err(400, "Add at least one email address to send the report to");
    if (!s.tags.length) return err(400, "Pick at least one tag — the report only includes tagged leads");
    const report = cresentReport(range, s.tags);
    const to = s.recipients.join(", ");
    mutateExt((e) =>
      e.cresent.sends.unshift({
        id: newId("cs"), weekStart: range.start, rangeEnd: range.end, scheduled: false, tags: s.tags,
        rowCount: report.leadCount, emailedAt: nowIso(), emailedTo: to, emailError: null, createdAt: nowIso(),
      }),
    );
    return ok({ rowCount: report.leadCount, to });
  });

  // ---- Lead sheet check -----------------------------------------------------

  on("GET", "/api/sheet-check", () => {
    const sc = ext().sheetCheck;
    const lastReal = sc.runs.find((r) => !r.dryRun && r.status !== "failed");
    return ok({
      settings: sc.settings,
      sources: sc.sources,
      runs: sc.runs,
      nextDueAt: sc.settings.enabled && lastReal
        ? new Date(Date.parse(lastReal.startedAt) + sc.settings.intervalDays * 24 * HOUR - 2 * HOUR).toISOString()
        : null,
      serviceAccountEmail: "lead-sheet-check@meridian-demo.iam.gserviceaccount.com",
      cronSecretConfigured: true,
    });
  });
  on("PUT", "/api/sheet-check/settings", ({ body }) => {
    mutateExt((e) => Object.assign(e.sheetCheck.settings, body as object));
    return ok(ext().sheetCheck.settings);
  });
  on("POST", "/api/sheet-check/sources", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const url = str(b.sheetUrl);
    if (!/docs\.google\.com\/spreadsheets\/d\//.test(url)) {
      return err(400, "Paste the full Google Sheets link (docs.google.com/spreadsheets/d/…)");
    }
    const id = newId("ss");
    mutateExt((e) =>
      e.sheetCheck.sources.push({
        id, name: str(b.name) || "Lead sheet", sheetUrl: url, campaignLabel: str(b.campaignLabel) || null,
        enabled: true, lastRowNumber: null, lastCheckedAt: null, lastStatus: null, lastMessage: null,
      }),
    );
    return ok({ id }, 201);
  });
  on("PATCH", "/api/sheet-check/sources/:id", ({ params, body }) => {
    mutateExt((e) => {
      const s = e.sheetCheck.sources.find((x) => x.id === params.id);
      if (s) Object.assign(s, body as object);
    });
    return ok({ id: params.id });
  });
  on("DELETE", "/api/sheet-check/sources/:id", ({ params }) => {
    mutateExt((e) => (e.sheetCheck.sources = e.sheetCheck.sources.filter((x) => x.id !== params.id)));
    return ok({ id: params.id, deleted: true });
  });
  on("POST", "/api/sheet-check/sources/:id/test", ({ params }) => {
    const s = ext().sheetCheck.sources.find((x) => x.id === params.id);
    if (!s) return err(400, "Sheet not found");
    const rows = (s.lastRowNumber ?? 120) + 3;
    return ok({
      spreadsheetTitle: s.name, tabTitle: s.name.split(" — ")[0] ?? s.name, rows, leads: rows - 2,
      headerRow: 2, skipped: 1, lastLead: { rowNumber: rows, createdTime: new Date(Date.now() - 3 * HOUR).toISOString() },
    });
  });
  on("POST", "/api/sheet-check/run", ({ body }) => {
    const dryRun = (body as { dryRun?: boolean } | null)?.dryRun !== false;
    return ok(runSheetCheck(dryRun, currentUser().sub));
  });
}

// ---------------------------------------------------------------------------
// Activity monitor — real demo activity for the day, over a believable
// working-day pattern so any date the viewer picks has something to read.
// ---------------------------------------------------------------------------

function seeded(n: number) {
  let s = n >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function hash(text: string) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function activityMonitor(day: string) {
  const db = getDb();
  const start = Date.parse(`${day}T00:00:00.000Z`) - IST;
  const now = Date.now();
  const nowBucket = now < start ? -1 : now >= start + 24 * HOUR ? null : Math.floor((now - start) / 600_000);
  const lastSlot = nowBucket === null ? 143 : nowBucket;
  const weekday = new Date(start + IST).getUTCDay();

  const users = DEMO_USERS.filter((u) => u.role !== "VIEWER").map((u) => {
    const counts = new Array(144).fill(0) as number[];
    // Real activity the viewer created while clicking around the demo.
    for (const a of db.activities) {
      if (a.actorSub !== u.sub) continue;
      const t = Date.parse(a.createdAt);
      if (t >= start && t < start + 24 * HOUR) counts[Math.floor((t - start) / 600_000)]! += 1;
    }
    // Background working pattern: shift hours, a lunch dip, idle stretches.
    const r = seeded(hash(`${u.sub}:${day}`));
    const off = weekday === 0 || (u.role === "SALES" && hash(`${u.sub}${day}`) % 7 === 0);
    if (!off && u.role !== "STAFF") {
      const from = u.role === "DOCTOR" || u.role === "DOCTORADMIN" ? 60 : 54 + Math.floor(r() * 4);
      const to = from + 48 + Math.floor(r() * 10);
      const busy = u.role === "SALES" || u.role === "RECEPTION" ? 0.62 : 0.4;
      for (let i = from; i < Math.min(to, lastSlot + 1); i++) {
        if (i >= 78 && i < 84 && r() < 0.8) continue; // lunch
        if (r() < busy) counts[i]! += 1 + Math.floor(r() * (u.role === "MANAGER" ? 6 : 4));
      }
    }
    const active = counts.map((c, i) => [c, i] as const).filter(([c]) => c > 0);
    const at = (i: number) => new Date(start + i * 600_000 + 120_000).toISOString();
    return {
      sub: u.sub,
      name: u.name,
      role: u.role,
      counts,
      total: counts.reduce((a, c) => a + c, 0),
      activeBuckets: active.length,
      firstAt: active.length ? at(active[0]![1]) : null,
      lastAt: active.length ? at(active[active.length - 1]![1]) : null,
    };
  });
  users.sort((a, b) => b.activeBuckets - a.activeBuckets || b.total - a.total || a.name.localeCompare(b.name));
  return { day, bucketMinutes: 10, dayStart: new Date(start).toISOString(), nowBucket, users };
}

/** Latest action per person, over the same pattern — the Users "Last active" column. */
export function demoLastActiveAt(sub: string): string | null {
  const today = istDayOf(new Date());
  for (const day of [today, istDayOf(new Date(Date.now() - 24 * HOUR)), istDayOf(new Date(Date.now() - 48 * HOUR))]) {
    const row = activityMonitor(day).users.find((u) => u.sub === sub);
    if (row?.lastAt) return row.lastAt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cresent — the real report logic over the demo's leads, calls and messages.
// ---------------------------------------------------------------------------

function parseRange(q: URLSearchParams): { start: string; end: string } | { error: string } {
  const from = q.get("from");
  const to = q.get("to");
  if (from || to) {
    if (!from || !to || !isYmd(from) || !isYmd(to)) return { error: "Pick both a from and a to date" };
    if (from > to) return { error: "The from date must be on or before the to date" };
    if (rangeDays(from, to) > MAX_RANGE_DAYS) return { error: `Pick a range of ${MAX_RANGE_DAYS} days or less` };
    return { start: from, end: to };
  }
  const week = q.get("week") ?? addWeeks(istWeekStart(new Date()), -1);
  if (!isWeekStart(week)) return { error: "week must be a Monday, YYYY-MM-DD" };
  return { start: week, end: addDays(week, 6) };
}

function cresentReport(range: { start: string; end: string }, tags: string[]) {
  const db = getDb();
  const from = Date.parse(`${range.start}T00:00:00.000Z`) - IST;
  const to = Date.parse(`${range.end}T00:00:00.000Z`) + 24 * HOUR - IST;
  const leads: CresentLeadDTO[] = [];
  for (const e of db.enquiries) {
    const t = Date.parse(e.createdAt);
    if (e.deletedAt || t < from || t >= to) continue;
    const g = db.guests.find((x) => x.id === e.guestId);
    if (!g) continue;
    const all = mergeLeadTags(e.tags, { phone: g.phone }, e);
    const matched = matchingTags(all, tags);
    if (!matched.length) continue;
    const contacts: RawContact[] = [
      ...db.calls.filter((c) => c.enquiryId === e.id).map((c) =>
        callContact({ startedAt: new Date(c.startedAt), direction: c.direction, status: c.status, durationSec: c.durationSec, notes: c.notes })),
      ...db.messages
        .filter((m) => m.guestId === g.id && m.direction === "outbound" && (m.channel === "whatsapp" || m.channel === "email") && Date.parse(m.createdAt) >= t)
        .map((m) => messageContact({ at: new Date(m.createdAt), channel: m.channel as "whatsapp" | "email", status: m.status })),
    ];
    const remarks = db.notes.filter((n) => n.enquiryId === e.id).map((n) => ({ at: new Date(n.createdAt), text: n.body }));
    leads.push({
      enquiryId: e.id, receivedAt: e.createdAt, tags: matched, name: g.fullName, phone: g.phone ?? "",
      email: g.email ?? "", city: g.city ?? "", touches: buildTouches(contacts, remarks), stage: e.stage as never,
    });
  }
  return { rangeStart: range.start, rangeEnd: range.end, tags, leadCount: leads.length, days: groupByDay(leads), generatedAt: nowIso() };
}

// ---------------------------------------------------------------------------
// Lead sheet check — a believable run: every enabled sheet is "read", and
// one lead that never reached the CRM is found and (for a full run) added.
// ---------------------------------------------------------------------------

const MISSED = [
  { name: "Kiran Deshpande", city: "Pune" },
  { name: "Lakshmi Varadan", city: "Chennai" },
  { name: "Harpreet Sandhu", city: "Chandigarh" },
];

function runSheetCheck(dryRun: boolean, actorSub: string) {
  const sc = ext().sheetCheck;
  const enabled = sc.sources.filter((s) => s.enabled);
  if (!enabled.length) return { error: "No sheets are set up to check" };
  const r = seeded(Date.now());
  const missedIdx = Math.floor(r() * enabled.length);
  const who = MISSED[Math.floor(r() * MISSED.length)]!;
  const summaries: DemoSheetSummary[] = enabled.map((s, i) => {
    const checked = 10 + Math.floor(r() * 8);
    const missing = i === missedIdx ? 1 : 0;
    return {
      sourceId: s.id, name: s.name, tab: s.name.split(" — ")[0] ?? s.name, leadsInSheet: (s.lastRowNumber ?? 120) + 2,
      checked, heldBack: r() < 0.3 ? 1 : 0, missing, pushed: dryRun ? 0 : missing, pushFailed: 0, error: null,
    };
  });
  const source = enabled[missedIdx]!;
  const receivedAt = new Date(Date.now() - (26 + Math.floor(r() * 30)) * HOUR).toISOString();
  const pushResult = dryRun ? "Not added" : pushMissedLead(who, source.campaignLabel, actorSub);
  const settings = sc.settings;
  const run: DemoSheetRun = {
    id: newId("run"), trigger: "manual", dryRun, status: "issues",
    checkedCount: summaries.reduce((a, s) => a + s.checked, 0), missingCount: 1,
    pushedCount: dryRun ? 0 : 1, pushFailedCount: 0, sheetErrors: 0, summary: summaries, hasCsv: true,
    emailedAt: dryRun ? null : nowIso(), emailedTo: dryRun ? null : settings.recipients.join(", "),
    emailError: null, error: null, startedAt: nowIso(), finishedAt: nowIso(),
  };
  mutateExt((e) => {
    e.sheetCheck.runs.unshift(run);
    if (!dryRun) {
      for (const s of summaries) {
        const src = e.sheetCheck.sources.find((x) => x.id === s.sourceId);
        if (!src) continue;
        src.lastCheckedAt = nowIso();
        src.lastRowNumber = s.leadsInSheet + 1;
        src.lastStatus = s.missing ? "missing" : "ok";
        src.lastMessage = s.missing ? `1 of ${s.checked} checked were missing — 1 added` : `All ${s.checked} checked are in the CRM`;
      }
    }
  });
  return {
    runId: run.id, status: run.status, checked: run.checkedCount, missing: 1, pushed: run.pushedCount, pushFailed: 0, sheetErrors: 0,
    sheets: summaries,
    missingLeads: [{ sheet: source.name, rowNumber: (source.lastRowNumber ?? 120) + 1, name: who.name, receivedAt, result: pushResult }],
    emailedTo: run.emailedTo, emailError: null,
  };
}

/** A full run adds the missed lead to the board, the way the real check does. */
function pushMissedLead(who: { name: string; city: string }, campaignLabel: string | null, actorSub: string): string {
  mutateDb((db) => {
    const guestId = newId("guest");
    const enquiryId = newId("enq");
    const now = nowIso();
    db.guests.push({
      id: guestId, fullName: who.name, phone: `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`,
      email: null, gender: null, city: who.city, ageGroup: null, tags: [], isReturning: false, isBlocked: false,
      consentGiven: true, referralCodeUsed: null, aiReturnScore: null, aiReturnReason: null, aiNextProgram: null, createdAt: now, updatedAt: now,
    });
    const enquiry: DemoEnquiry = {
      id: enquiryId, guestId, stage: "new_lead" as EnquiryStage, source: "facebook", assignedToSub: null, assignedToName: null,
      packageId: null, referralCodeId: null, isReturningFlag: false, quotedPriceINR: null, proposedDates: null, lostReason: null,
      campaignLabel, intakeNotes: "Added by the lead sheet check — this sheet row hadn't reached the CRM", tags: [],
      boardPosition: 0, needsAttention: true, aiScore: null, aiScoreReason: null, aiAssist: null, aiAssistAt: null,
      rnrProgress: null, doctorDecision: null, doctorDecisionAt: null, doctorDecisionNote: null, lostRequestPending: false,
      preferredCheckIn: null, deletedAt: null, lastActivityAt: now, createdAt: now, updatedAt: now,
    };
    db.enquiries.unshift(enquiry);
    db.activities.push({
      id: newId("act"), enquiryId, guestId, actorSub: actorSub || "sheet-check", actorRole: "system",
      actorName: "Lead sheet check", actionType: "created", metadata: { source: "facebook", via: "sheet-check" }, createdAt: now,
    });
  });
  return "Added to CRM now";
}

// ---------------------------------------------------------------------------
// CSV downloads. These are plain <a href> navigations, which the fetch mock
// never sees — interceptor.ts catches the click and saves what this builds.
// ---------------------------------------------------------------------------

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
const tagLabel = (t: string) => t.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function demoDownload(href: string): { filename: string; text: string } | null {
  const u = new URL(href, "http://demo.local");
  const path = u.pathname;
  if (path === "/api/reports/cresent" && u.searchParams.get("format") === "csv") {
    const range = parseRange(u.searchParams);
    if ("error" in range) return null;
    const tags = (u.searchParams.get("tags") ?? "").split(",").filter(Boolean);
    const report = cresentReport(range, tags.length ? tags : ext().cresent.settings.tags);
    return {
      filename: `cresent-report-${range.start}-to-${range.end}.csv`,
      text: toCsv([CSV_HEADERS, ...csvRows(report as never, tagLabel)]),
    };
  }
  const run = path.match(/^\/api\/sheet-check\/runs\/([^/]+)\/csv\/?$/);
  if (run) {
    const r = ext().sheetCheck.runs.find((x) => x.id === run[1]);
    if (!r) return null;
    const rows = [["Sheet", "Row", "Name", "Phone", "Received at", "Result"]];
    r.summary.filter((s) => s.missing).forEach((s, i) => {
      const who = MISSED[i % MISSED.length]!;
      rows.push([s.name, String(s.leadsInSheet), who.name, "+91 98XXX XXXXX", r.startedAt, r.dryRun ? "Not added (check only)" : "Added to CRM"]);
    });
    return { filename: `missed-leads-${r.startedAt.slice(0, 10)}.csv`, text: toCsv(rows) };
  }
  const mkt = path.match(/^\/api\/reports\/marketing\/([^/]+)\/download\/?$/);
  if (mkt) {
    const db = getDb();
    const rep = db.marketingReports.find((x) => x.id === mkt[1]);
    const rows = [["Lead", "Phone", "Source", "Campaign", "Stage", "Created at"]];
    for (const e of db.enquiries.filter((x) => !x.deletedAt).slice(0, rep?.rowCount ?? 50)) {
      const g = db.guests.find((x) => x.id === e.guestId);
      rows.push([g?.fullName ?? "", g?.phone ?? "", e.source, e.campaignLabel ?? "", e.stage, e.createdAt]);
    }
    return { filename: rep?.filename ?? "marketing-report.csv", text: toCsv(rows) };
  }
  return null;
}
