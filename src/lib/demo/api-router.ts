"use client";

/**
 * Demo-mode mock API router. Every /api/** call the app makes goes through
 * the fetch interceptor (installed in providers.tsx) into here instead of a
 * real network request — there's no backend at all in this deployment.
 *
 * Response envelope matches the real app's convention (src/lib/client.ts):
 * `{ data: <payload> }`. Handlers return that payload; wrapping happens once
 * at the bottom.
 */
import { getDb, mutateDb, newId, nowIso } from "./store";
import { DEMO_MAILBOXES, DEMO_USERS } from "./seed";
import { readClientSessionCookie } from "./session";
import { PERMISSION_CATALOG, PERMISSION_GROUP_ORDER } from "../permissions-catalog";
import { ALL_ROLES, permissionsFor, type AppRole } from "../rbac";
import { CRM_ROLE_TO_APP_ROLE, type CrmRole } from "../keycloak-roles";
import type {
  DemoData,
  DemoEnquiry,
  DemoGuest,
  DemoMarketingReport,
  DemoMessage,
  DemoTask,
  EnquiryStage,
} from "./types";

// ---------------------------------------------------------------------------
// DTO mappers — shape the flat demo records the way the real API/DTOs do
// (src/lib/types.ts) so components render identically to main.
// ---------------------------------------------------------------------------

function toGuestDTO(g: DemoGuest) {
  return {
    id: g.id,
    fullName: g.fullName,
    phone: g.phone,
    email: g.email,
    city: g.city,
    gender: g.gender,
    ageGroup: g.ageGroup,
    isReturning: g.isReturning,
    tags: g.tags,
  };
}

function toEnquiryDTO(db: DemoData, e: DemoEnquiry) {
  const guest = db.guests.find((g) => g.id === e.guestId);
  return {
    id: e.id,
    stage: e.stage,
    source: e.source,
    assignedToSub: e.assignedToSub,
    assignedToName: e.assignedToName,
    isReturningFlag: e.isReturningFlag,
    quotedPriceINR: e.quotedPriceINR,
    campaignLabel: e.campaignLabel,
    intakeNotes: e.intakeNotes,
    boardPosition: e.boardPosition,
    needsAttention: e.needsAttention,
    aiScore: e.aiScore,
    aiScoreReason: e.aiScoreReason,
    aiAssist: e.aiAssist,
    aiAssistAt: e.aiAssistAt,
    tags: e.tags,
    lastActivityAt: e.lastActivityAt,
    createdAt: e.createdAt,
    guest: guest ? toGuestDTO(guest) : null,
    rnrProgress: e.rnrProgress,
    doctorDecision: e.doctorDecision,
    doctorDecisionAt: e.doctorDecisionAt,
    doctorDecisionNote: e.doctorDecisionNote,
    lostRequestPending: e.lostRequestPending,
    packageId: e.packageId,
    proposedDates: e.proposedDates,
    lostReason: e.lostReason,
    preferredCheckIn: e.preferredCheckIn,
  };
}

/** Live (non-archived) leads. Every board/list/report query goes through this
 *  so a soft-deleted lead can't leak back into the pipeline. */
function liveEnquiries(db: DemoData): DemoEnquiry[] {
  return db.enquiries.filter((e) => !e.deletedAt);
}

function toTimelineDTO(db: DemoData, enquiryId: string) {
  const notes = db.notes
    .filter((n) => n.enquiryId === enquiryId)
    .map((n) => ({
      id: n.id,
      kind: "note" as const,
      actorName: n.authorName,
      actorRole: n.authorRole,
      text: n.body,
      createdAt: n.createdAt,
      attachment: null,
    }));
  const activities = db.activities
    .filter((a) => a.enquiryId === enquiryId)
    .map((a) => ({
      id: a.id,
      kind: "activity" as const,
      actorName: a.actorName,
      actorRole: a.actorRole,
      text: describeActivity(a.actionType, a.metadata),
      createdAt: a.createdAt,
      actionType: a.actionType,
      meta: a.metadata,
    }));
  return [...notes, ...activities].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function toMessageDTO(m: DemoMessage, all?: DemoMessage[]) {
  // The quoted message a reply points at. Resolved against the same thread the
  // caller already has in hand, so this stays a pure lookup.
  const parent = m.replyToId && all ? all.find((x) => x.id === m.replyToId) : undefined;
  return {
    id: m.id,
    direction: m.direction,
    mailboxId: m.mailboxId,
    subject: m.subject,
    body: m.body,
    bodyHtml: m.bodyHtml,
    fromEmail: m.fromEmail,
    toEmail: m.toEmail,
    status: m.status,
    needsReview: m.needsReview,
    createdAt: m.createdAt,
    attachment: m.attachment ?? null,
    fromLabel: m.fromLabel,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    replyTo: parent ? { id: parent.id, body: parent.body, direction: parent.direction } : null,
  };
}

const THREAD_PAGE_SIZE = 25;

/**
 * Newest-first page of a guest's thread on one channel. The real API cursors
 * on the message id; here an offset is enough and keeps "Load older" honest
 * about when it's run out of history.
 */
function pageThread(
  messages: DemoMessage[],
  guestId: string,
  channel: DemoMessage["channel"],
  opts: { mailboxId?: string | null; cursor?: string | null } = {},
) {
  const all = messages
    .filter((m) => m.guestId === guestId && m.channel === channel)
    .filter((m) => !opts.mailboxId || m.mailboxId === opts.mailboxId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest-first
  const offset = Number.parseInt(opts.cursor ?? "", 10) || 0;
  const page = all.slice(offset, offset + THREAD_PAGE_SIZE);
  const nextOffset = offset + page.length;
  return {
    items: page.map((m) => toMessageDTO(m, messages)),
    nextCursor: nextOffset < all.length ? String(nextOffset) : null,
  };
}

function describeActivity(actionType: string, meta: Record<string, unknown>): string {
  switch (actionType) {
    case "created":
      return `Lead created via ${String(meta.source ?? "unknown source")}.`;
    case "assign":
      return `Assigned to ${String(meta.to ?? "a staff member")}.`;
    case "stage_change":
      return `Stage changed from ${String(meta.from)} to ${String(meta.to)}.`;
    default:
      return actionType.replace(/_/g, " ");
  }
}

function currentUser() {
  const s = readClientSessionCookie();
  if (!s) return DEMO_USERS[0]!;
  return DEMO_USERS.find((u) => u.sub === s.sub) ?? DEMO_USERS[0]!;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

interface RouteCtx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}
interface HandlerResult {
  status: number;
  data: unknown;
  /** Extra top-level envelope keys alongside `data` (e.g. `meta.stats`). */
  meta?: Record<string, unknown>;
  /** Skip the `{ data }` envelope entirely — a couple of real routes
   *  (src/app/api/staff-profiles/route.ts) return a bare JSON array and are
   *  read by raw `fetch()` call sites that don't unwrap `.data`. */
  raw?: boolean;
}
type Handler = (ctx: RouteCtx) => HandlerResult | Promise<HandlerResult>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

function on(method: string, pattern: string, handler: Handler) {
  const keys: string[] = [];
  const regexStr = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  routes.push({ method, regex: new RegExp(`^${regexStr}/?$`), keys, handler });
}

function ok(data: unknown, status = 200, extra?: { meta?: Record<string, unknown>; raw?: boolean }): HandlerResult {
  return { status, data, meta: extra?.meta, raw: extra?.raw };
}

function findOr404<T>(arr: T[], pred: (x: T) => boolean): T | null {
  return arr.find(pred) ?? null;
}

// ---- Enquiries / Leads -----------------------------------------------------

on("GET", "/api/enquiries", ({ query }) => {
  const db = getDb();
  let list = liveEnquiries(db);
  const q = query.get("q")?.toLowerCase();
  const stage = query.get("stage");
  const source = query.get("source");
  const gender = query.get("gender");
  const city = query.get("city");
  const tag = query.get("tag");
  const assignee = query.get("assignee");
  if (q) {
    list = list.filter((e) => {
      const g = db.guests.find((gg) => gg.id === e.guestId);
      return (
        g?.fullName.toLowerCase().includes(q) ||
        g?.phone?.toLowerCase().includes(q) ||
        g?.email?.toLowerCase().includes(q)
      );
    });
  }
  if (stage) list = list.filter((e) => e.stage === stage);
  if (source) list = list.filter((e) => e.source === source);
  if (tag) list = list.filter((e) => e.tags.includes(tag));
  if (assignee === "me") {
    const me = currentUser();
    list = list.filter((e) => e.assignedToSub === me.sub);
  } else if (assignee) {
    list = list.filter((e) => e.assignedToSub === assignee);
  }
  if (gender || city) {
    list = list.filter((e) => {
      const g = db.guests.find((gg) => gg.id === e.guestId);
      if (gender && g?.gender !== gender) return false;
      if (city && g?.city !== city) return false;
      return true;
    });
  }
  return ok(list.map((e) => toEnquiryDTO(db, e)));
});

on("POST", "/api/enquiries", ({ body }) => {
  const input = body as Record<string, unknown>;
  const me = currentUser();
  const db = mutateDb((d) => {
    const guest: DemoGuest = {
      id: newId("guest"),
      fullName: String(input.fullName ?? "New Guest"),
      phone: (input.phone as string) || null,
      email: (input.email as string) || null,
      gender: (input.gender as string) || null,
      city: (input.city as string) || null,
      ageGroup: null,
      tags: (input.tags as string[]) ?? [],
      isReturning: false,
      isBlocked: false,
      consentGiven: true,
      referralCodeUsed: (input.referralCode as string) || null,
      aiReturnScore: null,
      aiReturnReason: null,
      aiNextProgram: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    d.guests.push(guest);
    const enquiry: DemoEnquiry = {
      id: newId("enq"),
      guestId: guest.id,
      stage: "new_lead",
      source: String(input.source ?? "other"),
      assignedToSub: me.sub,
      assignedToName: me.name,
      packageId: null,
      referralCodeId: null,
      isReturningFlag: false,
      quotedPriceINR: null,
      proposedDates: null,
      lostReason: null,
      campaignLabel: (input.campaignLabel as string) || null,
      intakeNotes: (input.note as string) || null,
      tags: (input.tags as string[]) ?? [],
      boardPosition: d.enquiries.filter((e) => e.stage === "new_lead").length,
      needsAttention: false,
      aiScore: null,
      aiScoreReason: null,
      aiAssist: null,
      aiAssistAt: null,
      rnrProgress: null,
      doctorDecision: null,
      doctorDecisionAt: null,
      doctorDecisionNote: null,
      lostRequestPending: false,
      preferredCheckIn: (input.preferredCheckIn as string) || null,
      deletedAt: null,
      lastActivityAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    d.enquiries.push(enquiry);
    d.activities.push({
      id: newId("act"),
      enquiryId: enquiry.id,
      guestId: guest.id,
      actorSub: me.sub,
      actorRole: me.role,
      actorName: me.name,
      actionType: "created",
      metadata: { source: enquiry.source },
      createdAt: nowIso(),
    });
  });
  const created = db.enquiries[db.enquiries.length - 1]!;
  return ok(
    {
      enquiry: toEnquiryDTO(db, created),
      returning: { isReturning: false, priorEnquiries: 0 },
    },
    201,
  );
});

on("GET", "/api/enquiries/assignable-users", () => {
  return ok(DEMO_USERS.filter((u) => u.role === "SALES" || u.role === "RECEPTION" || u.role === "MANAGER" || u.role === "ADMIN").map((u) => ({ id: u.sub, name: u.name, role: u.role })));
});

on("GET", "/api/enquiries/check-existing", ({ query }) => {
  const phone = query.get("phone");
  const db = getDb();
  const guest = phone ? db.guests.find((g) => g.phone === phone) : null;
  return ok({ exists: Boolean(guest), guest: guest ? toGuestDTO(guest) : null });
});

on("GET", "/api/enquiries/:id", ({ params }) => {
  const db = getDb();
  const e = findOr404(db.enquiries, (x) => x.id === params.id);
  if (!e) return { status: 404, data: { error: { code: "NOT_FOUND", message: "Lead not found" } } };
  return ok(toEnquiryDTO(db, e));
});

on("PATCH", "/api/enquiries/:id", ({ params, body }) => {
  const input = body as Record<string, unknown>;
  const db = mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === params.id);
    if (!e) return;
    const g = d.guests.find((x) => x.id === e.guestId);
    if (g) {
      if (typeof input.fullName === "string") g.fullName = input.fullName;
      if (typeof input.phone === "string") g.phone = input.phone;
      if (typeof input.email === "string") g.email = input.email;
      if (typeof input.city === "string") g.city = input.city;
    }
    if ("assignedToSub" in input) {
      e.assignedToSub = (input.assignedToSub as string) ?? null;
      e.assignedToName = e.assignedToSub ? DEMO_USERS.find((u) => u.sub === e.assignedToSub)?.name ?? (input.assignedToName as string) ?? null : null;
    }
    if (typeof input.quotedPriceINR === "number" || input.quotedPriceINR === null) e.quotedPriceINR = input.quotedPriceINR as number | null;
    if (typeof input.stage === "string") e.stage = input.stage as EnquiryStage;
    if (typeof input.needsAttention === "boolean") e.needsAttention = input.needsAttention;
    if ("intakeNotes" in input) e.intakeNotes = (input.intakeNotes as string) ?? null;
    e.updatedAt = nowIso();
    e.lastActivityAt = nowIso();
  });
  const e = db.enquiries.find((x) => x.id === params.id);
  if (!e) return { status: 404, data: { error: { code: "NOT_FOUND", message: "Lead not found" } } };
  return ok(toEnquiryDTO(db, e));
});

on("PATCH", "/api/enquiries/:id/stage", ({ params, body }) => {
  const { stage } = body as { stage: EnquiryStage };
  const me = currentUser();
  const db = mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === params.id);
    if (!e) return;
    const from = e.stage;
    e.stage = stage;
    e.boardPosition = d.enquiries.filter((x) => x.stage === stage).length;
    e.lastActivityAt = nowIso();
    e.updatedAt = nowIso();
    if (stage === "lost") {
      e.lostReason = e.lostReason ?? "Not interested";
      e.lostRequestPending = false;
    }
    d.activities.push({
      id: newId("act"),
      enquiryId: e.id,
      guestId: e.guestId,
      actorSub: me.sub,
      actorRole: me.role,
      actorName: me.name,
      actionType: "stage_change",
      metadata: { from, to: stage },
      createdAt: nowIso(),
    });
  });
  const e = db.enquiries.find((x) => x.id === params.id);
  if (!e) return { status: 404, data: { error: { code: "NOT_FOUND", message: "Lead not found" } } };
  return ok(toEnquiryDTO(db, e));
});

on("POST", "/api/enquiries/:id/notes", ({ params, body }) => {
  const { body: text } = body as { body: string };
  const me = currentUser();
  const db = mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === params.id);
    if (!e) return;
    d.notes.push({
      id: newId("note"),
      enquiryId: e.id,
      authorSub: me.sub,
      authorName: me.name,
      authorRole: me.role,
      body: text,
      createdAt: nowIso(),
    });
    e.lastActivityAt = nowIso();
  });
  return ok(toTimelineDTO(db, params.id), 201);
});

on("GET", "/api/enquiries/:id/timeline", ({ params }) => {
  const db = getDb();
  return ok(toTimelineDTO(db, params.id));
});

// The drawer PATCHes; keep POST too so either verb behaves the same rather
// than one of them silently falling through to the generic echo fallback.
const updateEnquiryTags: Handler = ({ params, body }) => {
  const { add, remove } = body as { add?: string; remove?: string };
  const db = mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === params.id);
    if (!e) return;
    if (add && !e.tags.includes(add)) e.tags.push(add);
    if (remove) e.tags = e.tags.filter((t) => t !== remove);
  });
  const e = db.enquiries.find((x) => x.id === params.id);
  return ok(e ? toEnquiryDTO(db, e) : null);
};
on("POST", "/api/enquiries/:id/tags", updateEnquiryTags);
on("PATCH", "/api/enquiries/:id/tags", updateEnquiryTags);

on("GET", "/api/enquiries/:id/tasks", ({ params }) => {
  const db = getDb();
  return ok(db.tasks.filter((t) => t.enquiryId === params.id));
});

on("POST", "/api/enquiries/:id/tasks", ({ params, body }) => {
  const input = body as Record<string, unknown>;
  const me = currentUser();
  const db = mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === params.id);
    const g = e ? d.guests.find((x) => x.id === e.guestId) : null;
    const task: DemoTask = {
      id: newId("task"),
      enquiryId: params.id,
      guestName: g?.fullName ?? "Guest",
      title: String(input.title ?? "Follow up"),
      dueAt: (input.dueAt as string) ?? null,
      status: "open",
      kind: "follow_up",
      approved: null,
      assignedToSub: (input.assignedToSub as string) ?? me.sub,
      createdBy: me.sub,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    d.tasks.push(task);
  });
  return ok(db.tasks[db.tasks.length - 1], 201);
});

// The consultation queue PATCHes this; POST is kept alongside so neither verb
// falls through to the generic echo fallback and silently does nothing.
const recordDoctorDecision: Handler = ({ params, body }) => {
  const { decision, note } = body as { decision: "accepted" | "rejected" | "needs_phone_consult"; note?: string };
  const me = currentUser();
  const db = mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === params.id);
    if (!e) return;
    e.doctorDecision = decision;
    e.doctorDecisionAt = nowIso();
    e.doctorDecisionNote = note ?? null;
    e.lastActivityAt = nowIso();
    d.activities.push({
      id: newId("act"),
      enquiryId: e.id,
      guestId: e.guestId,
      actorSub: me.sub,
      actorRole: me.role,
      actorName: me.name,
      actionType: "doctor_decision",
      metadata: { decision },
      createdAt: nowIso(),
    });
  });
  const e = db.enquiries.find((x) => x.id === params.id);
  return ok(e ? toEnquiryDTO(db, e) : null);
};
on("POST", "/api/enquiries/:id/doctor-decision", recordDoctorDecision);
on("PATCH", "/api/enquiries/:id/doctor-decision", recordDoctorDecision);

/**
 * `?mode=soft` archives the lead (it shows up under Deleted, restorable);
 * `?mode=hard` purges it and its history outright, same as the real route.
 */
on("DELETE", "/api/enquiries/:id", ({ params, query }) => {
  const hard = query.get("mode") === "hard";
  mutateDb((d) => {
    if (hard) {
      d.enquiries = d.enquiries.filter((x) => x.id !== params.id);
      d.messages = d.messages.filter((m) => m.enquiryId !== params.id);
      d.notes = d.notes.filter((n) => n.enquiryId !== params.id);
      d.activities = d.activities.filter((a) => a.enquiryId !== params.id);
      d.tasks = d.tasks.filter((t) => t.enquiryId !== params.id);
      return;
    }
    const e = d.enquiries.find((x) => x.id === params.id);
    if (e) {
      e.deletedAt = nowIso();
      e.updatedAt = e.deletedAt;
    }
  });
  return ok({ id: params.id, mode: hard ? "hard" : "soft" });
});

on("POST", "/api/enquiries/:id/request-lost", ({ params, body }) => {
  const { reason } = body as { reason?: string };
  const db = mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === params.id);
    if (!e) return;
    e.lostRequestPending = true;
    e.lostReason = reason ?? e.lostReason;
  });
  const e = db.enquiries.find((x) => x.id === params.id);
  return ok(e ? toEnquiryDTO(db, e) : null);
});

on("POST", "/api/enquiries/:id/whatsapp-call", () => ok({ success: true }));

// ---- Guests -----------------------------------------------------------------

on("GET", "/api/guests", ({ query }) => {
  const db = getDb();
  let list = db.guests.slice();
  const q = query.get("q")?.toLowerCase();
  const gender = query.get("gender");
  const returning = query.get("returning");
  const tags = query.get("tags");
  if (q) {
    list = list.filter(
      (g) => g.fullName.toLowerCase().includes(q) || g.phone?.includes(q) || g.email?.toLowerCase().includes(q),
    );
  }
  if (gender) list = list.filter((g) => g.gender === gender);
  if (returning) list = list.filter((g) => (returning === "true" ? g.isReturning : !g.isReturning));
  if (tags) {
    const wanted = tags.split(",").filter(Boolean);
    list = list.filter((g) => wanted.every((t) => g.tags.includes(t)));
  }
  const items = list.map((g) => ({
    id: g.id,
    fullName: g.fullName,
    phone: g.phone ?? "",
    email: g.email,
    city: g.city,
    gender: g.gender,
    ageGroup: g.ageGroup,
    isReturning: g.isReturning,
    isBlocked: g.isBlocked,
    tags: g.tags,
    enquiryCount: liveEnquiries(db).filter((e) => e.guestId === g.id).length,
    hasHealthProfile: false,
    consentGiven: g.consentGiven,
    aiReturnScore: g.aiReturnScore,
    aiReturnReason: g.aiReturnReason,
    aiNextProgram: g.aiNextProgram,
    createdAt: g.createdAt,
  }));
  return ok({ items, total: items.length });
});

on("POST", "/api/guests", ({ body }) => {
  const input = body as Record<string, unknown>;
  const db = mutateDb((d) => {
    d.guests.push({
      id: newId("guest"),
      fullName: String(input.fullName ?? "New Guest"),
      phone: (input.phone as string) || null,
      email: (input.email as string) || null,
      gender: (input.gender as string) || null,
      city: (input.city as string) || null,
      ageGroup: null,
      tags: [],
      isReturning: false,
      isBlocked: false,
      consentGiven: false,
      referralCodeUsed: null,
      aiReturnScore: null,
      aiReturnReason: null,
      aiNextProgram: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  });
  return ok(db.guests[db.guests.length - 1], 201);
});

on("GET", "/api/guests/:id", ({ params }) => {
  const db = getDb();
  const g = findOr404(db.guests, (x) => x.id === params.id);
  if (!g) return { status: 404, data: { error: { code: "NOT_FOUND", message: "Guest not found" } } };
  return ok({
    ...toGuestDTO(g),
    isBlocked: g.isBlocked,
    consentGiven: g.consentGiven,
    aiReturnScore: g.aiReturnScore,
    aiReturnReason: g.aiReturnReason,
    aiNextProgram: g.aiNextProgram,
    createdAt: g.createdAt,
    enquiries: liveEnquiries(db).filter((e) => e.guestId === g.id).map((e) => toEnquiryDTO(db, e)),
  });
});

on("PATCH", "/api/guests/:id", ({ params, body }) => {
  const input = body as Record<string, unknown>;
  const db = mutateDb((d) => {
    const g = d.guests.find((x) => x.id === params.id);
    if (!g) return;
    Object.assign(g, input, { updatedAt: nowIso() });
  });
  const g = db.guests.find((x) => x.id === params.id);
  return ok(g ? toGuestDTO(g) : null);
});

on("DELETE", "/api/guests/:id", ({ params }) => {
  mutateDb((d) => {
    d.guests = d.guests.filter((x) => x.id !== params.id);
  });
  return ok({ success: true });
});

on("GET", "/api/guests/:id/messages", ({ params }) => {
  const db = getDb();
  return ok(db.messages.filter((m) => m.guestId === params.id));
});

// ---- Conversation threads (lead drawer: Email + WhatsApp tabs) -------------

on("GET", "/api/guests/:id/conversation", ({ params, query }) => {
  const db = getDb();
  const guest = db.guests.find((g) => g.id === params.id);
  const mailboxId = query.get("mailbox") || null;
  const { items, nextCursor } = pageThread(db.messages, params.id, "email", {
    mailboxId,
    cursor: query.get("cursor"),
  });
  // Whichever mailbox this guest was last mailed from is the natural From
  // address; falls back to the first configured one for a fresh thread.
  const lastOutbound = db.messages
    .filter((m) => m.guestId === params.id && m.channel === "email" && m.direction === "outbound")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const active =
    DEMO_MAILBOXES.find((mb) => mb.id === (mailboxId ?? lastOutbound?.mailboxId)) ?? DEMO_MAILBOXES[0]!;
  const me = currentUser();
  return ok({
    items,
    nextCursor,
    activeMailbox: active.id,
    guestEmail: guest?.email ?? null,
    fromAddress: active.address,
    // Viewers are read-only in the real app; everyone else can reply as long
    // as the guest actually left an address.
    canSend: Boolean(guest?.email) && me.role !== "VIEWER",
    mailboxOptions: DEMO_MAILBOXES.map((mb) => ({ id: mb.id, label: mb.label })),
  });
});

on("GET", "/api/guests/:id/whatsapp", ({ params, query }) => {
  const db = getDb();
  const guest = db.guests.find((g) => g.id === params.id);
  const { items, nextCursor } = pageThread(db.messages, params.id, "whatsapp", {
    cursor: query.get("cursor"),
  });
  const connected = db.whatsappNumbers.filter((n) => n.status === "connected");
  const numberOptions = connected.map((n) => ({
    id: n.id,
    label: n.label,
    phoneNumber: n.phoneNumber,
    isDefault: n.isDefault,
    instanceName: n.instanceName,
  }));
  // Messages store the number's instanceName in mailboxId, so the thread's
  // last message tells us which line this conversation already lives on.
  const lastMailboxId = db.messages
    .filter((m) => m.guestId === params.id && m.channel === "whatsapp")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]?.mailboxId;
  const me = currentUser();
  return ok({
    items,
    nextCursor,
    guestPhone: guest?.phone ?? null,
    canSend: Boolean(guest?.phone) && numberOptions.length > 0 && me.role !== "VIEWER",
    numberOptions,
    suggestedNumberId: connected.find((n) => n.instanceName === lastMailboxId)?.id ?? null,
    myNumberId: connected.find((n) => n.phoneNumber && n.phoneNumber === me.phone)?.id ?? null,
  });
});

// ---- Messages -------------------------------------------------------------

/** Shared body shape for both send endpoints. */
function sendInput(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    guestId: typeof b.guestId === "string" ? b.guestId : null,
    enquiryId: typeof b.enquiryId === "string" ? b.enquiryId : null,
    numberId: typeof b.numberId === "string" ? b.numberId : null,
    subject: typeof b.subject === "string" ? b.subject : null,
    body: typeof b.body === "string" ? b.body : "",
    html: typeof b.html === "string" ? b.html : null,
    attachmentDocumentId:
      typeof b.attachmentDocumentId === "string" ? b.attachmentDocumentId : null,
  };
}

on("POST", "/api/messages/email", ({ body }) => {
  const input = sendInput(body);
  const db = getDb();
  const guest = db.guests.find((g) => g.id === input.guestId);
  if (!guest) throw new Error("Guest not found");
  if (!guest.email) throw new Error("This guest has no email address on file.");
  const lastOutbound = db.messages
    .filter((m) => m.guestId === guest.id && m.channel === "email" && m.direction === "outbound")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const mailbox = DEMO_MAILBOXES.find((mb) => mb.id === lastOutbound?.mailboxId) ?? DEMO_MAILBOXES[0]!;
  const msg: DemoMessage = {
    id: newId("msg"),
    guestId: guest.id,
    enquiryId: input.enquiryId,
    mailboxId: mailbox.id,
    channel: "email",
    direction: "outbound",
    subject: input.subject ?? `Re: Your enquiry with Meridian Wellness`,
    body: input.body,
    bodyHtml: input.html,
    fromEmail: mailbox.address,
    toEmail: guest.email,
    status: "sent",
    needsReview: false,
    fromLabel: mailbox.label,
    editedAt: null,
    deletedAt: null,
    attachment: lookupUpload(input.attachmentDocumentId),
    createdAt: nowIso(),
  };
  mutateDb((d) => {
    d.messages.push(msg);
  });
  return ok(toMessageDTO(msg));
});

on("POST", "/api/messages/whatsapp", ({ body }) => {
  const input = sendInput(body);
  const db = getDb();
  const guest = db.guests.find((g) => g.id === input.guestId);
  if (!guest) throw new Error("Guest not found");
  if (!guest.phone) throw new Error("This guest has no phone number on file.");
  const number =
    db.whatsappNumbers.find((n) => n.id === input.numberId) ??
    db.whatsappNumbers.find((n) => n.isDefault && n.status === "connected");
  if (!number) throw new Error("No connected WhatsApp number to send from.");
  const msg: DemoMessage = {
    id: newId("msg"),
    guestId: guest.id,
    enquiryId: input.enquiryId,
    mailboxId: number.instanceName,
    channel: "whatsapp",
    direction: "outbound",
    subject: null,
    body: input.body,
    bodyHtml: null,
    fromEmail: null,
    toEmail: null,
    status: "sent",
    needsReview: false,
    fromLabel: number.label,
    editedAt: null,
    deletedAt: null,
    attachment: lookupUpload(input.attachmentDocumentId),
    createdAt: nowIso(),
  };
  mutateDb((d) => {
    d.messages.push(msg);
  });
  return ok(toMessageDTO(msg));
});

on("PATCH", "/api/messages/:id", ({ params, body }) => {
  const text = String((body as Record<string, unknown>)?.body ?? "").trim();
  if (!text) throw new Error("Message body can't be empty.");
  const editedAt = nowIso();
  mutateDb((d) => {
    const m = d.messages.find((x) => x.id === params.id);
    if (m) {
      m.body = text;
      m.editedAt = editedAt;
    }
  });
  return ok({ id: params.id, body: text, editedAt });
});

on("DELETE", "/api/messages/:id", ({ params }) => {
  const deletedAt = nowIso();
  mutateDb((d) => {
    const m = d.messages.find((x) => x.id === params.id);
    if (m) m.deletedAt = deletedAt;
  });
  return ok({ id: params.id, deletedAt });
});

// ---- Tasks --------------------------------------------------------------

on("GET", "/api/tasks", ({ query }) => {
  const db = getDb();
  let list = db.tasks.slice();
  const status = query.get("status");
  const mine = query.get("assignee");
  if (status) list = list.filter((t) => t.status === status);
  if (mine === "me") {
    const me = currentUser();
    list = list.filter((t) => t.assignedToSub === me.sub);
  }
  return ok(list.sort((a, b) => ((a.dueAt ?? "") < (b.dueAt ?? "") ? -1 : 1)));
});

on("PATCH", "/api/tasks/:id", ({ params, body }) => {
  const input = body as Record<string, unknown>;
  const db = mutateDb((d) => {
    const t = d.tasks.find((x) => x.id === params.id);
    if (!t) return;
    Object.assign(t, input, { updatedAt: nowIso() });
  });
  const t = db.tasks.find((x) => x.id === params.id);
  return ok(t ?? null);
});

on("DELETE", "/api/tasks/:id", ({ params }) => {
  mutateDb((d) => {
    d.tasks = d.tasks.filter((x) => x.id !== params.id);
  });
  return ok({ success: true });
});

// ---- Packages -------------------------------------------------------------

on("GET", "/api/packages", () => ok(getDb().packages));
on("POST", "/api/packages", ({ body }) => {
  const input = body as Record<string, unknown>;
  const db = mutateDb((d) => {
    d.packages.push({
      id: newId("pkg"),
      name: String(input.name ?? "New Package"),
      category: String(input.category ?? "residential"),
      durationDays: Number(input.durationDays ?? 1),
      basePriceINR: Number(input.basePriceINR ?? 0),
      therapies: (input.therapies as string[]) ?? [],
      isActive: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  });
  return ok(db.packages[db.packages.length - 1], 201);
});
on("PATCH", "/api/packages/:id", ({ params, body }) => {
  const db = mutateDb((d) => {
    const p = d.packages.find((x) => x.id === params.id);
    if (p) Object.assign(p, body, { updatedAt: nowIso() });
  });
  return ok(db.packages.find((x) => x.id === params.id) ?? null);
});
on("DELETE", "/api/packages/:id", ({ params }) => {
  mutateDb((d) => {
    const p = d.packages.find((x) => x.id === params.id);
    if (p) p.isActive = false;
  });
  return ok({ success: true });
});

// ---- Referrals --------------------------------------------------------------

on("GET", "/api/referrals", () => ok(getDb().referrals));
on("POST", "/api/referrals", ({ body }) => {
  const input = body as Record<string, unknown>;
  const db = mutateDb((d) => {
    d.referrals.push({
      id: newId("ref"),
      code: String(input.code ?? `REF${Math.floor(Math.random() * 9000 + 1000)}`).toUpperCase(),
      issuedToGuestId: null,
      campaignLabel: (input.campaignLabel as string) || null,
      maxRedemptions: Number(input.maxRedemptions ?? 0),
      redemptionCount: 0,
      isActive: true,
      createdAt: nowIso(),
    });
  });
  return ok(db.referrals[db.referrals.length - 1], 201);
});
on("PATCH", "/api/referrals/:id", ({ params, body }) => {
  const db = mutateDb((d) => {
    const rcode = d.referrals.find((x) => x.id === params.id);
    if (rcode) Object.assign(rcode, body);
  });
  return ok(db.referrals.find((x) => x.id === params.id) ?? null);
});

// ---- Calls ------------------------------------------------------------------

function toCallDTO(db: DemoData, c: DemoData["calls"][number]) {
  const guest = c.guestId ? db.guests.find((g) => g.id === c.guestId) : null;
  return {
    id: c.id,
    direction: c.direction,
    status: c.status,
    callUUID: c.id,
    guestId: c.guestId,
    guestName: c.guestName,
    guestPhone: guest?.phone ?? c.customerPhone,
    enquiryId: c.enquiryId,
    repKeycloakId: c.repKeycloakId,
    repName: c.repName,
    repPhone: c.repPhone,
    customerPhone: c.customerPhone,
    startedAt: c.startedAt,
    answeredAt: c.answeredAt,
    endedAt: c.endedAt,
    durationSec: c.durationSec,
    hasRecording: Boolean(c.recordingUrl),
    recordingDurSec: c.recordingUrl ? c.durationSec : null,
    tags: c.tags,
    notes: c.notes,
    transcript: c.transcript,
    transcriptEnglish: c.transcriptEnglish,
    transcriptLanguage: c.transcriptLanguage,
    aiSummary: c.aiSummary,
    aiScore: c.aiScore,
    aiTags: c.aiTags,
    aiSuggestions: c.aiSuggestions,
    aiAnalyzedAt: c.aiAnalyzedAt,
  };
}

on("GET", "/api/calls", ({ query }) => {
  const db = getDb();
  let list = db.calls.slice().sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const rep = query.get("rep");
  if (rep === "me") {
    const me = currentUser();
    list = list.filter((c) => c.repKeycloakId === me.sub);
  }
  return ok({ items: list.map((c) => toCallDTO(db, c)), nextCursor: null });
});
on("GET", "/api/calls/:id", ({ params }) => {
  const db = getDb();
  const c = db.calls.find((x) => x.id === params.id);
  return c ? ok(toCallDTO(db, c)) : { status: 404, data: { error: { code: "NOT_FOUND", message: "Call not found" } } };
});
on("POST", "/api/calls/:id/analyze", ({ params }) => {
  const me = currentUser();
  const db = mutateDb((d) => {
    const c = d.calls.find((x) => x.id === params.id);
    if (!c) return;
    c.aiSummary = c.aiSummary ?? "Guest showed strong interest in the programme and asked about pricing and available dates.";
    c.aiScore = c.aiScore ?? Math.floor(55 + Math.random() * 40);
    c.aiTags = c.aiTags.length ? c.aiTags : ["high-intent", "price-discussion"];
    c.aiSuggestions = c.aiSuggestions ?? {
      hookLine: "Good opening — greeted the guest warmly and referenced their enquiry.",
      explanation: "Clearly explained programme options; could ask more discovery questions before pitching price.",
      professionalism: "Professional and courteous tone throughout.",
    };
    c.transcript = c.transcript ?? "Rep: Hello, thanks for your interest in Meridian Wellness. Guest: Hi, I wanted to know more about your detox programmes.";
    c.aiAnalyzedAt = nowIso();
    d.aiDecisions.unshift({
      id: newId("aidec"),
      kind: "call_analysis",
      callId: c.id,
      enquiryId: c.enquiryId,
      guestId: c.guestId,
      subjectLabel: c.guestName,
      provider: "ollama",
      model: "gemma3:latest",
      promptSystem: "You are a sales-call quality analyst for a wellness retreat CRM.",
      promptUser: `Transcript:\n${c.transcript}`,
      output: { summary: c.aiSummary, score: c.aiScore, tags: c.aiTags, suggestions: c.aiSuggestions },
      success: true,
      triggeredBy: me.sub,
      triggeredByName: me.name,
      createdAt: nowIso(),
    });
  });
  const analyzed = db.calls.find((x) => x.id === params.id);
  return ok(analyzed ? toCallDTO(db, analyzed) : null);
});
on("POST", "/api/calls/initiate", ({ body }) => {
  const input = body as Record<string, unknown>;
  const me = currentUser();
  const db = mutateDb((d) => {
    d.calls.unshift({
      id: newId("call"),
      direction: "outbound",
      status: "completed",
      guestId: (input.guestId as string) ?? null,
      enquiryId: (input.enquiryId as string) ?? null,
      guestName: String(input.guestName ?? "Guest"),
      repKeycloakId: me.sub,
      repName: me.name,
      repPhone: me.phone,
      customerPhone: String(input.customerPhone ?? "+91 90000 00000"),
      startedAt: nowIso(),
      answeredAt: nowIso(),
      endedAt: nowIso(),
      durationSec: 0,
      recordingUrl: null,
      tags: [],
      notes: null,
      transcript: null,
      transcriptEnglish: null,
      transcriptLanguage: null,
      aiSummary: null,
      aiScore: null,
      aiTags: [],
      aiSuggestions: null,
      aiAnalyzedAt: null,
      createdAt: nowIso(),
    });
  });
  return ok(toCallDTO(db, db.calls[0]!), 201);
});

// ---- AI -----------------------------------------------------------------

const AI_NEXT_ACTIONS = [
  { title: "Send pricing follow-up on WhatsApp", priority: "high" as const, reason: "Guest asked about pricing 2 days ago with no reply since." },
  { title: "Schedule a doctor consultation call", priority: "medium" as const, reason: "Guest has a pre-existing condition worth reviewing before quoting a programme." },
  { title: "Share the seasonal detox brochure", priority: "low" as const, reason: "Guest is still early in the funnel — a brochure keeps them warm without being pushy." },
];

on("POST", "/api/ai/assist", ({ body }) => {
  const { enquiryId } = body as { enquiryId: string };
  const me = currentUser();
  const db = mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === enquiryId);
    if (!e) return;
    const guest = d.guests.find((g) => g.id === e.guestId);
    const name = guest?.fullName ?? "the guest";
    const assist = {
      summary: `${name} came in via ${e.source.replace("_", " ")}${e.campaignLabel ? ` (${e.campaignLabel})` : ""} and is currently at the "${e.stage.replace(/_/g, " ")}" stage. ${e.aiScore ? `AI conversion score is ${e.aiScore}/100.` : ""} ${e.needsAttention ? "This lead needs attention." : "No urgent flags right now."}`.trim(),
      nextActions: AI_NEXT_ACTIONS.slice(0, 2 + Math.floor(Math.random() * 2)),
      draft: {
        channel: "whatsapp",
        subject: "",
        body: `Hi ${name.split(" ")[0]}! Just following up on your enquiry with Meridian Wellness — happy to answer any questions about our programmes or share pricing. Let me know what works best for you! 🌿`,
      },
    };
    e.aiAssist = assist;
    e.aiAssistAt = nowIso();
    d.aiDecisions.unshift({
      id: newId("aidec"),
      kind: "conversation_assist",
      callId: null,
      enquiryId: e.id,
      guestId: e.guestId,
      subjectLabel: name,
      provider: "ollama",
      model: "gemma3:latest",
      promptSystem: "You are a sales assistant for a wellness retreat CRM. Summarize the lead and suggest next actions + a draft reply.",
      promptUser: `Stage: ${e.stage}. Source: ${e.source}.`,
      output: assist,
      success: true,
      triggeredBy: me.sub,
      triggeredByName: me.name,
      createdAt: nowIso(),
    });
  });
  const e = db.enquiries.find((x) => x.id === enquiryId);
  return ok(e?.aiAssist ?? null);
});

on("GET", "/api/ai/decisions", ({ query }) => {
  const db = getDb();
  let list = db.aiDecisions.slice();
  const kind = query.get("kind");
  const success = query.get("success");
  if (kind) list = list.filter((d) => d.kind === kind);
  if (success) list = list.filter((d) => String(d.success) === success);
  const items = list.map((d) => ({
    id: d.id,
    kind: d.kind,
    callId: d.callId,
    enquiryId: d.enquiryId,
    guestId: d.guestId,
    guestName: d.subjectLabel,
    provider: d.provider,
    model: d.model,
    success: d.success,
    errorMessage: null,
    durationMs: Math.floor(400 + Math.random() * 2200),
    triggeredBy: d.triggeredBy,
    triggeredByName: d.triggeredByName,
    createdAt: d.createdAt,
  }));
  return ok(
    { items, nextCursor: null },
    200,
    { meta: { meta: { stats: { total: db.aiDecisions.length, success: db.aiDecisions.filter((d) => d.success).length, failed: db.aiDecisions.filter((d) => !d.success).length } } } },
  );
});
// NOTE: the double `meta: { meta: {...} } }` above is intentional — `ok()`'s
// `extra.meta` object is spread onto the top-level response payload
// (`{ data, ...meta }`), and the ai-decisions page reads `json.meta.stats`,
// so the spread key itself must be named "meta".

on("GET", "/api/ai/decisions/:id", ({ params }) => {
  const d = getDb().aiDecisions.find((x) => x.id === params.id);
  return d ? ok(d) : { status: 404, data: { error: { code: "NOT_FOUND", message: "Not found" } } };
});

on("POST", "/api/ai/pipeline", () => ok({ started: true, message: "Background AI pipeline run queued (demo — completes instantly)." }));

// ---- Staff / users --------------------------------------------------------

const CRM_ROLE_OF: Record<string, string> = {
  ADMIN: "crm-admin", DOCTOR: "crm-doctor", MANAGER: "crm-manager",
  RECEPTION: "crm-reception", SALES: "crm-sales", STAFF: "crm-staff", VIEWER: "crm-viewer",
};

on("GET", "/api/staff-profiles", () =>
  // Real route returns a bare array (NextResponse.json(profiles), no `{data}`
  // envelope) — src/app/(app)/activity/page.tsx reads it with a raw
  // fetch().then(r => r.json()) that doesn't unwrap `.data`.
  ok(DEMO_USERS.map((u) => ({ keycloakId: u.sub, displayName: u.name, phone: u.phone, isOnline: u.isOnline, role: u.role })), 200, { raw: true }),
);
on("GET", "/api/staff-profiles/me", () => {
  const me = currentUser();
  return ok({ keycloakId: me.sub, displayName: me.name, phone: me.phone, isOnline: me.isOnline, role: me.role });
});
on("GET", "/api/admin/users", () =>
  ok(
    DEMO_USERS.map((u) => ({
      id: u.sub,
      username: u.email.split("@")[0],
      email: u.email,
      firstName: u.name.split(" ")[0],
      lastName: u.name.split(" ").slice(1).join(" ") || null,
      fullName: u.name,
      phone: u.phone,
      enabled: true,
      role: CRM_ROLE_OF[u.role] ?? null,
      appRole: u.role,
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
  ),
);
on("GET", "/api/admin/call-routing", () => ok({ scope: "reception_sales" }));
on("GET", "/api/admin/lead-deletion", () => ok({ autoDeleteDays: 30 }));
on("GET", "/api/admin/lead-assignment", () =>
  ok(
    (["whatsapp", "email", "call", "google_sheets"] as const).map((category) => ({
      category,
      strategy: "round_robin" as const,
      eligibleSubs: [] as string[],
    })),
  ),
);
on("PATCH", "/api/admin/lead-assignment", ({ body }) => ok(body));

// ---- WhatsApp / templates / broadcast / autoreplies ------------------------

on("GET", "/api/admin/whatsapp/numbers", () => ok(getDb().whatsappNumbers.map((n) => ({ ...n, wabaId: null }))));
on("GET", "/api/whatsapp/numbers", () => ok(getDb().whatsappNumbers.filter((n) => n.status === "connected")));
on("GET", "/api/whatsapp/autoreplies", () => ok(getDb().autoReplies));
on("POST", "/api/whatsapp/autoreplies", ({ body }) => {
  const input = body as Record<string, unknown>;
  const db = mutateDb((d) => {
    d.autoReplies.push({
      id: newId("ar"),
      numberId: String(input.numberId ?? d.whatsappNumbers[0]?.id ?? ""),
      triggerWord: (input.triggerWord as string) || null,
      replyText: String(input.replyText ?? ""),
      enabled: true,
      createdAt: nowIso(),
    });
  });
  return ok(db.autoReplies[db.autoReplies.length - 1], 201);
});
on("PATCH", "/api/whatsapp/autoreplies/:id", ({ params, body }) => {
  const db = mutateDb((d) => {
    const a = d.autoReplies.find((x) => x.id === params.id);
    if (a) Object.assign(a, body);
  });
  return ok(db.autoReplies.find((x) => x.id === params.id) ?? null);
});
on("DELETE", "/api/whatsapp/autoreplies/:id", ({ params }) => {
  mutateDb((d) => {
    d.autoReplies = d.autoReplies.filter((x) => x.id !== params.id);
  });
  return ok({ success: true });
});

on("GET", "/api/message-templates", () => ok(getDb().messageTemplates));
on("POST", "/api/message-templates", ({ body }) => {
  const input = body as Record<string, unknown>;
  const db = mutateDb((d) => {
    d.messageTemplates.push({
      id: newId("tmpl"),
      channel: (input.channel as "email" | "whatsapp") ?? "whatsapp",
      name: String(input.name ?? "New template"),
      subject: (input.subject as string) || null,
      body: String(input.body ?? ""),
      createdBy: currentUser().sub,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  });
  return ok(db.messageTemplates[db.messageTemplates.length - 1], 201);
});

on("GET", "/api/broadcast-status", () =>
  ok(
    getDb().broadcastJobs.filter((j) => !j.deletedAt).map((j) => {
      const number = getDb().whatsappNumbers.find((n) => n.id === j.numberId);
      return {
        id: j.id,
        status: j.status,
        message: j.message,
        templateName: null,
        numberLabel: number?.label ?? "Sales Line",
        delaySec: 3,
        totalCount: j.totalCount,
        sentCount: j.sentCount,
        failedCount: j.failedCount,
        cursor: j.sentCount,
        createdByName: "Ananya Krishnan",
        createdAt: j.createdAt,
        completedAt: j.completedAt,
      };
    }),
  ),
);

// ---- Reports / activity / dashboard-adjacent -------------------------------

on("GET", "/api/activity", ({ query }) => {
  const db = getDb();
  let list = db.activities.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const type = query.get("actionType");
  if (type) list = list.filter((a) => a.actionType === type);
  return ok(list.slice(0, 200));
});

on("GET", "/api/reports/activity", ({ query }) => {
  const db = getDb();
  let list = db.activities.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const actorSub = query.get("actorSub");
  const actionType = query.get("actionType");
  const from = query.get("from");
  const to = query.get("to");
  if (actorSub) list = list.filter((a) => a.actorSub === actorSub);
  if (actionType) list = list.filter((a) => a.actionType === actionType);
  if (from) list = list.filter((a) => a.createdAt >= from);
  if (to) list = list.filter((a) => a.createdAt <= to);
  const items = list.slice(0, 100).map((a) => {
    const enquiry = a.enquiryId ? db.enquiries.find((e) => e.id === a.enquiryId) : null;
    const guest = enquiry ? db.guests.find((g) => g.id === enquiry.guestId) : null;
    return {
      id: a.id,
      createdAt: a.createdAt,
      actorSub: a.actorSub,
      actorName: a.actorName,
      actorRole: a.actorRole,
      actionType: a.actionType,
      actionLabel: describeActivity(a.actionType, a.metadata),
      enquiryId: a.enquiryId,
      guestName: guest?.fullName ?? null,
    };
  });
  return ok({ items, nextCursor: null });
});

on("GET", "/api/reports/campaigns", () => {
  const db = getDb();
  const labels = new Set<string>();
  for (const e of liveEnquiries(db)) if (e.campaignLabel) labels.add(e.campaignLabel);
  return ok(Array.from(labels).sort());
});

on("GET", "/api/reports/performance", () => {
  const db = getDb();
  const rows = DEMO_USERS.filter((u) => u.role === "SALES" || u.role === "RECEPTION" || u.role === "MANAGER").map((u) => {
    const owned = liveEnquiries(db).filter((e) => e.assignedToSub === u.sub);
    return {
      sub: u.sub,
      name: u.name,
      leadsCreated: owned.length,
      stageChanges: db.activities.filter((a) => a.actorSub === u.sub && a.actionType === "stage_change").length,
      notes: db.notes.filter((n) => n.authorSub === u.sub).length,
      messages: db.messages.filter((m) => owned.some((e) => e.id === m.enquiryId) && m.direction === "outbound").length,
      docsUploaded: 0,
      conversions: owned.filter((e) => e.stage === "converted" || e.stage === "booking_confirmed").length,
    };
  });
  return ok(rows);
});

on("GET", "/api/reports/source-stage-matrix", () => {
  const db = getDb();
  const rows: { source: string; stage: string; count: number }[] = [];
  const seen = new Map<string, number>();
  for (const e of liveEnquiries(db)) {
    const key = `${e.source}::${e.stage}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    const [source, stage] = key.split("::");
    rows.push({ source: source!, stage: stage!, count });
  }
  return ok(rows);
});

on("GET", "/api/health-profiles/:guestId", () => ok(null));

// ---- Documents / files ----------------------------------------------------

on("GET", "/api/files/meta", () => {
  const me = currentUser();
  const uploadable = me.role === "DOCTOR" ? ["medical", "consent", "operational"] : ["operational", "marketing"];
  return ok({ readable: ["operational", "marketing", "medical", "consent"], uploadable });
});
/**
 * The Resources library. `scope=attachable` is what the composer's attachment
 * picker asks for — files worth re-sending — so guest-scoped medical records
 * stay out of it unless that guest's own thread is the one being composed.
 */
on("GET", "/api/files", ({ query }) => {
  const db = getDb();
  const scope = query.get("scope");
  const guestId = query.get("guestId");
  const q = query.get("q")?.toLowerCase();
  let list = db.documents.slice();
  if (scope === "attachable") {
    list = list.filter((d) => d.guestId === null || (guestId && d.guestId === guestId));
  } else if (guestId) {
    list = list.filter((d) => d.guestId === guestId);
  }
  if (q) list = list.filter((d) => d.filename.toLowerCase().includes(q));
  list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return ok(
    list.map((d) => ({
      id: d.id,
      filename: d.filename,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      category: d.category,
      guestId: d.guestId,
      createdAt: d.createdAt,
    })),
  );
});

/**
 * Uploads pending a `/api/files/confirm`, keyed by storage key. Deliberately
 * in-memory (not in the persisted store): the browser never uploads bytes
 * anywhere in demo mode, so there's nothing worth surviving a reload — only
 * the confirmed metadata, which gets denormalised onto the message instead.
 */
const pendingUploads = new Map<string, { filename: string; mimeType: string }>();
const confirmedUploads = new Map<string, { id: string; filename: string; mimeType: string }>();

/**
 * Resolve an attachment id to its metadata. Two sources: a file just uploaded
 * through the presigned-PUT dance, or an existing Resources document picked
 * for reuse (attachment-picker.tsx) — which never goes through upload at all.
 */
function lookupUpload(id: string | null) {
  if (!id) return null;
  const uploaded = confirmedUploads.get(id);
  if (uploaded) return uploaded;
  const doc = getDb().documents.find((d) => d.id === id);
  return doc ? { id: doc.id, filename: doc.filename, mimeType: doc.mimeType } : null;
}

on("POST", "/api/files/upload-url", ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const storageKey = newId("demo-upload");
  pendingUploads.set(storageKey, {
    filename: String(b.filename ?? "attachment"),
    mimeType: String(b.mimeType ?? "application/octet-stream"),
  });
  // Points back at /api/** on purpose so the fetch interceptor swallows the
  // PUT instead of it escaping to a storage bucket that doesn't exist here.
  return ok({ url: `/api/files/demo-put/${storageKey}`, storageKey });
});

// The presigned PUT itself — the body is the raw File, which we discard.
on("PUT", "/api/files/demo-put/:storageKey", () => ok({ success: true }));

on("POST", "/api/files/confirm", ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const storageKey = String(b.storageKey ?? "");
  const pending = pendingUploads.get(storageKey);
  pendingUploads.delete(storageKey);
  const doc = {
    id: newId("doc"),
    filename: String(b.filename ?? pending?.filename ?? "attachment"),
    mimeType: String(b.mimeType ?? pending?.mimeType ?? "application/octet-stream"),
  };
  confirmedUploads.set(doc.id, doc);
  return ok(doc);
});

// ---- Tag vocabularies ------------------------------------------------------
// Four endpoints, one idea: the distinct tags actually in use, so a filter bar
// only ever offers values that will match something.

function distinctTags(values: string[][]): string[] {
  return [...new Set(values.flat())].sort((a, b) => a.localeCompare(b));
}

// The tag-input vocabulary. A bare string[] — the drawer renders these
// straight into <option> keys, so tag objects here produce a datalist of
// identical "[object Object]" keys.
on("GET", "/api/tags", () => {
  const db = getDb();
  return ok(distinctTags([db.tags.map((t) => t.value), ...db.enquiries.map((e) => e.tags)]));
});
on("GET", "/api/enquiries/tags", () => ok(distinctTags(liveEnquiries(getDb()).map((e) => e.tags))));
on("GET", "/api/guests/tags", () => ok(distinctTags(getDb().guests.map((g) => g.tags))));
on("GET", "/api/deleted-leads/tags", () =>
  ok(distinctTags(getDb().enquiries.filter((e) => e.deletedAt).map((e) => e.tags))),
);

// ---- Attention badge -------------------------------------------------------

/**
 * Leads waiting on someone. `?list=1` additionally returns what's waiting —
 * the unanswered inbound message or the overdue task — so the bell can open
 * straight into it rather than just showing a number.
 */
on("GET", "/api/enquiries/attention-count", ({ query }) => {
  const db = getDb();
  const me = currentUser();
  const scoped = liveEnquiries(db).filter(
    (e) =>
      // Admin/Manager see everything; everyone else sees their own book.
      me.role === "ADMIN" || me.role === "MANAGER" ? true : e.assignedToSub === me.sub,
  );
  const waiting = scoped.filter((e) => e.needsAttention || e.lostRequestPending);
  if (!query.get("list")) return ok({ count: waiting.length });

  const limit = Number.parseInt(query.get("limit") ?? "", 10) || 10;
  const items = waiting
    .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))
    .slice(0, limit)
    .map((e) => {
      const guest = db.guests.find((g) => g.id === e.guestId);
      // The most recent inbound message is what's actually unanswered.
      const lastInbound = db.messages
        .filter((m) => m.enquiryId === e.id && m.direction === "inbound" && !m.deletedAt)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      const openTask = db.tasks
        .filter((t) => t.enquiryId === e.id && t.status === "open")
        .sort((a, b) => ((a.dueAt ?? "") < (b.dueAt ?? "") ? -1 : 1))[0];
      return {
        enquiryId: e.id,
        guestName: guest?.fullName ?? "Unknown guest",
        stage: e.stage,
        lastActivityAt: e.lastActivityAt,
        message: lastInbound
          ? {
              channel: lastInbound.channel,
              preview: lastInbound.body.slice(0, 140),
              subject: lastInbound.subject,
              createdAt: lastInbound.createdAt,
            }
          : null,
        task: openTask ? { title: openTask.title, dueAt: openTask.dueAt } : null,
      };
    });
  return ok({ count: waiting.length, items });
});

// ---- Deleted leads (archive) ----------------------------------------------

function deletedLeadListItem(db: DemoData, e: DemoEnquiry) {
  const guest = db.guests.find((g) => g.id === e.guestId);
  const messages = db.messages.filter((m) => m.enquiryId === e.id);
  const calls = db.calls.filter((c) => c.enquiryId === e.id);
  return {
    id: e.id,
    guestId: e.guestId,
    guestName: guest?.fullName ?? "Unknown guest",
    guestPhone: guest?.phone ?? null,
    guestEmail: guest?.email ?? null,
    stage: e.stage,
    source: e.source,
    campaignLabel: e.campaignLabel,
    assignedToName: e.assignedToName,
    deletedAt: e.deletedAt!,
    createdAt: e.createdAt,
    tags: e.tags,
    counts: {
      activities: db.activities.filter((a) => a.enquiryId === e.id).length,
      messages: messages.length,
      calls: calls.length,
      recordings: calls.filter((c) => c.recordingUrl).length,
      notes: db.notes.filter((n) => n.enquiryId === e.id).length,
      tasks: db.tasks.filter((t) => t.enquiryId === e.id).length,
      documents: db.documents.filter((d) => d.enquiryId === e.id).length,
    },
  };
}

const DELETED_PAGE_SIZE = 25;

on("GET", "/api/deleted-leads", ({ query }) => {
  const db = getDb();
  const archived = db.enquiries.filter((e) => e.deletedAt);
  const q = query.get("q")?.toLowerCase();
  const source = query.get("source");
  const tags = (query.get("tags") ?? "").split(",").filter(Boolean);
  let list = archived;
  if (q) {
    list = list.filter((e) => {
      const g = db.guests.find((gg) => gg.id === e.guestId);
      return (
        g?.fullName.toLowerCase().includes(q) ||
        g?.phone?.toLowerCase().includes(q) ||
        g?.email?.toLowerCase().includes(q)
      );
    });
  }
  if (source) list = list.filter((e) => e.source === source);
  // AND semantics, matching the live board's multi-select tag filter.
  if (tags.length) list = list.filter((e) => tags.every((t) => e.tags.includes(t)));
  list = list.slice().sort((a, b) => (a.deletedAt! < b.deletedAt! ? 1 : -1));

  const offset = Number.parseInt(query.get("cursor") ?? "", 10) || 0;
  const page = list.slice(offset, offset + DELETED_PAGE_SIZE);
  const nextOffset = offset + page.length;
  return ok({
    items: page.map((e) => deletedLeadListItem(db, e)),
    nextCursor: nextOffset < list.length ? String(nextOffset) : null,
    matching: list.length,
    total: archived.length,
  });
});

on("GET", "/api/deleted-leads/:id", ({ params }) => {
  const db = getDb();
  const e = db.enquiries.find((x) => x.id === params.id && x.deletedAt);
  if (!e) throw new Error("Deleted lead not found");
  const messages = db.messages.filter((m) => m.enquiryId === e.id);
  return ok({
    ...deletedLeadListItem(db, e),
    lostReason: e.lostReason,
    quotedPriceINR: e.quotedPriceINR,
    proposedDates: e.proposedDates,
    intakeNotes: e.intakeNotes,
    aiScore: e.aiScore,
    aiScoreReason: e.aiScoreReason,
    activities: db.activities
      .filter((a) => a.enquiryId === e.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((a) => ({
        id: a.id,
        createdAt: a.createdAt,
        actorName: a.actorName,
        actorRole: a.actorRole,
        actionType: a.actionType,
        actionLabel: describeActivity(a.actionType, a.metadata),
        metadata: a.metadata,
      })),
    messages: messages
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((m) => ({
        id: m.id,
        channel: m.channel,
        direction: m.direction,
        subject: m.subject,
        body: m.body,
        fromEmail: m.fromEmail,
        toEmail: m.toEmail,
        status: m.status,
        createdAt: m.createdAt,
        attachment: m.attachment ?? null,
      })),
    calls: db.calls
      .filter((c) => c.enquiryId === e.id)
      .map((c) => ({
        id: c.id,
        direction: c.direction,
        status: c.status,
        customerPhone: c.customerPhone,
        repName: c.repName,
        startedAt: c.startedAt,
        durationSec: c.durationSec,
        hasRecording: Boolean(c.recordingUrl),
        transcript: c.transcript,
        transcriptEnglish: c.transcriptEnglish,
        aiSummary: c.aiSummary,
        aiScore: c.aiScore,
      })),
    notes: db.notes
      .filter((n) => n.enquiryId === e.id)
      .map((n) => ({ id: n.id, body: n.body, authorName: n.authorName, createdAt: n.createdAt })),
    tasks: db.tasks
      .filter((t) => t.enquiryId === e.id)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt, createdAt: t.createdAt })),
    documents: db.documents
      .filter((d) => d.enquiryId === e.id)
      .map((d) => ({ id: d.id, filename: d.filename, mimeType: d.mimeType, category: d.category, createdAt: d.createdAt })),
  });
});

/** Restore — clears the soft delete and puts the lead back on the board. */
on("PATCH", "/api/deleted-leads/:id", ({ params }) => {
  mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === params.id);
    if (e) {
      e.deletedAt = null;
      e.updatedAt = nowIso();
    }
  });
  return ok({ id: params.id, restored: true });
});

/** Purge — the archive's own delete, which is permanent even in the demo. */
on("DELETE", "/api/deleted-leads/:id", ({ params }) => {
  mutateDb((d) => {
    d.enquiries = d.enquiries.filter((x) => x.id !== params.id);
    d.messages = d.messages.filter((m) => m.enquiryId !== params.id);
    d.notes = d.notes.filter((n) => n.enquiryId !== params.id);
    d.activities = d.activities.filter((a) => a.enquiryId !== params.id);
    d.tasks = d.tasks.filter((t) => t.enquiryId !== params.id);
  });
  return ok({ id: params.id, purged: true });
});

// ---- Permissions matrix ----------------------------------------------------

/** Inverse of CRM_ROLE_TO_APP_ROLE — the demo stores users by app role, but
 *  the role picker is keyed on the Keycloak realm role. */
const APP_ROLE_TO_CRM_ROLE = Object.fromEntries(
  Object.entries(CRM_ROLE_TO_APP_ROLE).map(([crm, app]) => [app, crm as CrmRole]),
) as Record<AppRole, CrmRole>;

/**
 * Role change from the Permissions page. The real route refuses a self-role
 * change (an admin can't lock themselves out) — kept here so the demo shows
 * that guard rather than silently allowing it.
 */
on("PATCH", "/api/admin/users/:id", ({ params, body }) => {
  const crmRole = String((body as Record<string, unknown>)?.role ?? "") as CrmRole;
  const appRole = CRM_ROLE_TO_APP_ROLE[crmRole];
  if (!appRole) throw new Error("Unknown role");
  const me = currentUser();
  if (me.sub === params.id) {
    throw new Error("You can't change your own role — ask another administrator.");
  }
  mutateDb((d) => {
    const u = d.users.find((x) => x.sub === params.id);
    if (u) u.role = appRole;
  });
  return ok({ id: params.id, role: crmRole });
});

on("GET", "/api/permissions", () => {
  const db = getDb();
  // Catalog and matrix come straight from rbac.ts/permissions-catalog.ts —
  // the same modules the real route reads, so the demo can't drift from it.
  return ok({
    catalog: PERMISSION_CATALOG,
    groupOrder: PERMISSION_GROUP_ORDER,
    roles: ALL_ROLES,
    matrix: Object.fromEntries(ALL_ROLES.map((r) => [r, permissionsFor(r)])),
    users: db.users.map((u) => ({
      id: u.sub,
      fullName: u.name,
      username: u.email.split("@")[0],
      email: u.email,
      enabled: true,
      // `role` is the Keycloak realm role the picker's options are keyed on
      // ("crm-sales"); `appRole` is the CRM role it maps to ("SALES"). Mixing
      // the two makes every row's dropdown fall back to its first option.
      role: APP_ROLE_TO_CRM_ROLE[u.role as AppRole] ?? null,
      appRole: u.role,
      roleFetchError: false,
      permissions: permissionsFor(u.role as AppRole),
    })),
  });
});

// ---- Marketing report ------------------------------------------------------

on("GET", "/api/reports/marketing", () => {
  const db = getDb();
  return ok({
    ceoEmail: "ceo@meridianwellness.demo",
    reports: db.marketingReports
      .slice()
      .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1)),
  });
});

/** Generate — for a custom range when `from`/`to` are given, else "today". */
on("POST", "/api/reports/marketing", ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const from = typeof b.from === "string" ? b.from : null;
  const to = typeof b.to === "string" ? b.to : null;
  const db = getDb();
  const custom = Boolean(from && to);
  // Row count is the leads actually in range, so the number means something.
  const rows = liveEnquiries(db).filter((e) => {
    if (!custom) return e.createdAt.slice(0, 10) === nowIso().slice(0, 10);
    return e.createdAt >= from! && e.createdAt <= `${to!}T23:59:59.999Z`;
  }).length;
  const today = nowIso().slice(0, 10);
  const report: DemoMarketingReport = {
    id: newId("mrep"),
    reportDate: custom ? null : today,
    rangeStart: custom ? from! : `${today}T00:00:00.000Z`,
    rangeEnd: custom ? `${to!}T23:59:59.999Z` : `${today}T23:59:59.999Z`,
    custom,
    filename: custom ? `meridian-marketing-${from}_${to}.csv` : `meridian-marketing-${today}.csv`,
    rowCount: rows,
    sizeBytes: rows * 640 + 480,
    generatedAt: nowIso(),
    emailedAt: null,
    emailedTo: null,
    emailError: null,
  };
  mutateDb((d) => {
    d.marketingReports.push(report);
  });
  return ok({ rowCount: rows });
});

on("POST", "/api/reports/marketing/:id/email", ({ params }) => {
  const to = "ceo@meridianwellness.demo";
  mutateDb((d) => {
    const rep = d.marketingReports.find((x) => x.id === params.id);
    if (rep) {
      rep.emailedAt = nowIso();
      rep.emailedTo = to;
      rep.emailError = null;
    }
  });
  return ok({ to });
});

// ---- AI: inbound question analysis ----------------------------------------

/** Topic buckets, each with the keywords that classify an inbound message
 *  into it. Deliberately the same shape the real analysis returns. */
const INBOUND_TOPICS: { key: string; label: string; description: string; keywords: string[] }[] = [
  { key: "pricing", label: "Pricing & payment", description: "What it costs, deposits, EMI and discounts.", keywords: ["price", "pricing", "cost", "fee", "discount", "emi", "payment", "charge", "₹"] },
  { key: "availability", label: "Dates & availability", description: "When they can come, and what's open.", keywords: ["date", "dates", "available", "availability", "slot", "book", "when", "schedule"] },
  { key: "programme", label: "Programme details", description: "What's included, daily schedule, duration.", keywords: ["package", "programme", "program", "include", "schedule", "day", "therapy", "detox"] },
  { key: "medical", label: "Medical suitability", description: "Conditions, medication, whether it's safe for them.", keywords: ["diabetes", "bp", "medic", "condition", "doctor", "surgery", "pregnan", "suitable"] },
  { key: "logistics", label: "Travel & logistics", description: "Getting there, stay, food, what to bring.", keywords: ["location", "reach", "address", "travel", "airport", "room", "food", "stay"] },
];

on("GET", "/api/ai/inbound-analysis", ({ query }) => {
  const db = getDb();
  const days = Number.parseInt(query.get("days") ?? "90", 10) || 90;
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const inbound = db.messages.filter((m) => m.direction === "inbound" && m.createdAt >= cutoff && !m.deletedAt);

  // Short acknowledgements ("ok", "thanks") carry no question — counted as
  // noise so the shares below are shares of messages that actually asked
  // something, which is the number worth acting on.
  const isNoise = (b: string) => b.trim().length < 12 || /^(ok|okay|thanks|thank you|sure|yes|no)\b/i.test(b.trim());
  const noise = inbound.filter((m) => isNoise(m.body)).length;
  const analysable = inbound.filter((m) => !isNoise(m.body));

  // Split of the *analysed* set, not of all inbound — the page prints this
  // directly beneath the analysed total, so the two have to reconcile.
  const byChannel: Record<string, number> = {};
  for (const m of analysable) byChannel[m.channel] = (byChannel[m.channel] ?? 0) + 1;

  // The page renders these straight into `{share}%` and a bar width, so they
  // are whole percentages, not 0-1 fractions.
  const pct = (n: number) => (analysable.length ? Math.round((n / analysable.length) * 1000) / 10 : 0);

  const matchedIds = new Set<string>();
  const topics = INBOUND_TOPICS.map((t) => {
    const hits = analysable.filter((m) => t.keywords.some((k) => m.body.toLowerCase().includes(k)));
    hits.forEach((h) => matchedIds.add(h.id));
    // "Primary" = the topic's keyword appears first in the message, i.e. it's
    // what the guest led with rather than a passing mention.
    const primary = hits.filter((m) => {
      const lower = m.body.toLowerCase();
      const mine = Math.min(...t.keywords.map((k) => (lower.includes(k) ? lower.indexOf(k) : 1e9)));
      return INBOUND_TOPICS.every((o) =>
        o.key === t.key
          ? true
          : mine <= Math.min(...o.keywords.map((k) => (lower.includes(k) ? lower.indexOf(k) : 1e9))),
      );
    });
    const existingTemplates = db.messageTemplates
      .filter((tpl) => t.keywords.some((k) => tpl.body.toLowerCase().includes(k) || tpl.name.toLowerCase().includes(k)))
      .map((tpl) => ({ name: tpl.name, channels: [tpl.channel] }));
    return {
      key: t.key,
      label: t.label,
      description: t.description,
      primaryCount: primary.length,
      primaryShare: pct(primary.length),
      count: hits.length,
      share: pct(hits.length),
      examples: [...new Set(hits.map((m) => m.body.trim()))].slice(0, 6),
      existingTemplates,
      // The point of the report: a topic guests ask about with no template
      // covering it is a gap worth filling.
      gap: hits.length > 0 && existingTemplates.length === 0,
    };
  }).sort((a, b) => b.count - a.count);

  const unmatched = analysable.filter((m) => !matchedIds.has(m.id));
  return ok({
    from: cutoff,
    to: nowIso(),
    totalInbound: inbound.length,
    analysed: analysable.length,
    noise,
    internal: 0,
    forms: liveEnquiries(db).filter((e) => e.source === "website_form" && e.createdAt >= cutoff).length,
    byChannel,
    unmatched: unmatched.length,
    unmatchedExamples: [...new Set(unmatched.map((m) => m.body.trim()))].slice(0, 8),
    topics,
  });
});

on("POST", "/api/ai/inbound-analysis/suggest", ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const key = String(b.topic ?? b.topicKey ?? "");
  const topic = INBOUND_TOPICS.find((t) => t.key === key) ?? INBOUND_TOPICS[0]!;
  const questions = Array.isArray(b.questions) ? (b.questions as string[]) : [];
  const DRAFTS: Record<string, string> = {
    pricing: "Hi {name}, thanks for asking! Our programmes start at ₹6,500 for a day package and ₹68,000 for the 7-day Panchakarma Detox. That covers accommodation, all therapies, consultations and meals. We also offer EMI on programmes above ₹50,000. Would you like the full pricing sheet? — {rep_name}",
    availability: "Hi {name}, we currently have availability from the second week of next month, and a few slots earlier if you're flexible. If you let me know your preferred dates I'll hold a room for you while you decide. — {rep_name}",
    programme: "Hi {name}, here's what a typical day looks like: morning yoga and consultation, two therapy sessions, a personalised naturopathy diet, and evening meditation. Our doctor tailors the plan to you after an initial assessment. I've attached the full schedule. — {rep_name}",
    medical: "Hi {name}, thank you for sharing that. Our doctor reviews every guest's history before the programme starts and adjusts the therapies accordingly — several of our guests join us managing diabetes or blood pressure. Shall I set up a short call with Dr. Iyer? — {rep_name}",
    logistics: "Hi {name}, we're at Meridian Wellness Retreat, Shamirpet, about 45 minutes from Hyderabad airport. We can arrange pickup for you. Rooms are single or twin-sharing, and all meals are included. — {rep_name}",
  };
  return ok({
    name: `${topic.label} — standard reply`,
    body: DRAFTS[topic.key] ?? DRAFTS.pricing!,
    rationale: `Guests ask about ${topic.label.toLowerCase()} more than almost anything else in this window, and no template currently covers it. This draft answers the common form of the question directly and ends with a next step, so a rep can send it without editing.`,
    coversQuestions: questions.slice(0, 5),
  });
});

// ---- Campaign-based lead assignment ---------------------------------------

function campaignSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

on("GET", "/api/admin/lead-assignment/campaigns", () => {
  const db = getDb();
  const knownCampaigns = [
    ...new Set(liveEnquiries(db).map((e) => e.campaignLabel).filter((c): c is string => Boolean(c))),
  ].sort((a, b) => a.localeCompare(b));
  return ok({ rules: db.campaignRules, knownCampaigns });
});

on("PUT", "/api/admin/lead-assignment/campaigns", ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const label = String(b.campaignLabel ?? "").trim();
  if (!label) throw new Error("A campaign name is required.");
  const rule = {
    campaignSlug: campaignSlug(label),
    campaignLabel: label,
    strategy: (b.strategy === "least_busy" ? "least_busy" : "round_robin") as "round_robin" | "least_busy",
    eligibleSubs: Array.isArray(b.eligibleSubs) ? (b.eligibleSubs as string[]) : [],
  };
  mutateDb((d) => {
    const i = d.campaignRules.findIndex((r) => r.campaignSlug === rule.campaignSlug);
    // An empty eligibility list clears the rule rather than leaving a rule
    // that can never assign to anyone.
    if (!rule.eligibleSubs.length) {
      if (i >= 0) d.campaignRules.splice(i, 1);
      return;
    }
    if (i >= 0) d.campaignRules[i] = rule;
    else d.campaignRules.push(rule);
  });
  return ok(rule);
});

// ---- Task follow-up decisions ---------------------------------------------

on("PATCH", "/api/tasks/:id/decision", ({ params, body }) => {
  const approved = Boolean((body as Record<string, unknown>)?.approved);
  mutateDb((d) => {
    const t = d.tasks.find((x) => x.id === params.id);
    if (t) {
      t.approved = approved;
      t.status = approved ? "done" : "cancelled";
      t.updatedAt = nowIso();
    }
  });
  return ok({ id: params.id, approved });
});

// ---- Guest tags / block / health ------------------------------------------

on("PATCH", "/api/guests/:id/tags", ({ params, body }) => {
  const tags = (body as Record<string, unknown>)?.tags;
  const next = Array.isArray(tags) ? (tags as string[]) : [];
  mutateDb((d) => {
    const g = d.guests.find((x) => x.id === params.id);
    if (g) {
      g.tags = next;
      g.updatedAt = nowIso();
    }
  });
  return ok({ id: params.id, tags: next });
});

on("PATCH", "/api/guests/:id/block", ({ params, body }) => {
  const blocked = Boolean((body as Record<string, unknown>)?.blocked ?? true);
  mutateDb((d) => {
    const g = d.guests.find((x) => x.id === params.id);
    if (g) {
      g.isBlocked = blocked;
      g.updatedAt = nowIso();
    }
  });
  return ok({ id: params.id, isBlocked: blocked });
});

on("GET", "/api/guests/:id/health", () => ok(null));
on("DELETE", "/api/guests/:id/health", ({ params }) => ok({ id: params.id, cleared: true }));

// ---- Bulk guest operations -------------------------------------------------

on("POST", "/api/guests/bulk-delete", ({ body }) => {
  const ids = Array.isArray((body as Record<string, unknown>)?.ids)
    ? ((body as Record<string, unknown>).ids as string[])
    : [];
  mutateDb((d) => {
    d.guests = d.guests.filter((g) => !ids.includes(g.id));
    // Their leads go with them — the archive is for deleted *leads*, and a
    // lead whose guest no longer exists can't be rendered.
    d.enquiries = d.enquiries.filter((e) => !ids.includes(e.guestId));
  });
  return ok({ deleted: ids.length, failed: [] });
});

on("POST", "/api/guests/bulk-email", ({ body }) => {
  const ids = Array.isArray((body as Record<string, unknown>)?.ids)
    ? ((body as Record<string, unknown>).ids as string[])
    : [];
  const db = getDb();
  // Only guests with an address can actually be mailed; the rest are skipped,
  // which is the number the UI reports back.
  const sendable = db.guests.filter((g) => ids.includes(g.id) && g.email);
  return ok({ sent: sendable.length, skipped: ids.length - sendable.length, failed: 0, errors: [] });
});

on("POST", "/api/guests/bulk-import", () =>
  ok({ created: 0, updated: 0, skipped: 0, errors: ["File import isn't wired up in the demo — the data here is generated."] }),
);

// ---- Broadcast -------------------------------------------------------------

on("GET", "/api/guests/broadcast/status", () => {
  const running = getDb().broadcastJobs.find((j) => j.status === "running" || j.status === "queued");
  return ok(
    running
      ? {
          id: running.id,
          status: running.status,
          totalCount: running.totalCount,
          sentCount: running.sentCount,
          failedCount: running.failedCount,
          cursor: running.sentCount,
          createdAt: running.createdAt,
        }
      : null,
  );
});

on("POST", "/api/guests/broadcast", ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b.ids) ? (b.ids as string[]) : [];
  const job = {
    id: newId("bcast"),
    status: "running" as const,
    message: String(b.message ?? ""),
    numberId: String(b.numberId ?? getDb().whatsappNumbers[0]?.id ?? ""),
    totalCount: ids.length,
    sentCount: 0,
    failedCount: 0,
    createdAt: nowIso(),
    completedAt: null,
    deletedAt: null,
  };
  mutateDb((d) => {
    d.broadcastJobs.push(job);
  });
  return ok({ id: job.id, queued: ids.length });
});

on("POST", "/api/guests/broadcast/:id/cancel", ({ params }) => {
  mutateDb((d) => {
    const j = d.broadcastJobs.find((x) => x.id === params.id);
    if (j) {
      j.status = "cancelled";
      j.completedAt = nowIso();
    }
  });
  return ok({ id: params.id, status: "cancelled" });
});

/** Per-recipient breakdown for one broadcast job. */
on("GET", "/api/broadcast-status/:id", ({ params }) => {
  const db = getDb();
  const job = db.broadcastJobs.find((j) => j.id === params.id);
  const withPhone = db.guests.filter((g) => g.phone);
  const recipients = withPhone.slice(0, job?.totalCount ?? 25).map((g, i) => {
    const sent = i < (job?.sentCount ?? 0);
    const failed = !sent && i < (job?.sentCount ?? 0) + (job?.failedCount ?? 0);
    return {
      guestId: g.id,
      guestName: g.fullName,
      guestPhone: g.phone,
      status: failed ? ("failed" as const) : sent ? ("delivered" as const) : ("pending" as const),
      errorDetail: failed ? "Number not on WhatsApp" : null,
      sentAt: sent ? job?.createdAt ?? null : null,
    };
  });
  return ok({ recipients });
});

on("DELETE", "/api/broadcast-status/:id", ({ params }) => {
  mutateDb((d) => {
    const j = d.broadcastJobs.find((x) => x.id === params.id);
    if (j) j.deletedAt = nowIso();
  });
  return ok({ id: params.id, deleted: true });
});

// ---- Admin: users, numbers, settings ---------------------------------------

on("POST", "/api/admin/users", ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const crmRole = String(b.role ?? "crm-sales") as CrmRole;
  const user = {
    sub: newId("user"),
    name: String(b.fullName ?? "New Staff Member"),
    email: String(b.email ?? "new.staff@meridianwellness.demo"),
    role: CRM_ROLE_TO_APP_ROLE[crmRole] ?? "SALES",
    phone: (b.phone as string) || "",
    isOnline: false,
  };
  mutateDb((d) => {
    d.users.push(user);
  });
  return ok({ id: user.sub });
});

on("DELETE", "/api/admin/users/:id", ({ params }) => {
  const me = currentUser();
  if (me.sub === params.id) throw new Error("You can't delete your own account.");
  mutateDb((d) => {
    d.users = d.users.filter((u) => u.sub !== params.id);
  });
  return ok({ id: params.id, deleted: true });
});

on("POST", "/api/admin/users/:id/reset-password", () =>
  ok({ temporaryPassword: "demo-temp-password", note: "Not a real credential — the demo has no identity provider." }),
);

on("POST", "/api/admin/whatsapp/numbers", ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const number = {
    id: newId("wan"),
    label: String(b.label ?? "New Number"),
    phoneNumber: (b.phoneNumber as string) || null,
    instanceName: campaignSlug(String(b.label ?? "new-number")),
    status: "pending" as const,
    isDefault: false,
    shared: Boolean(b.shared ?? true),
    integration: (b.integration === "cloud_api" ? "cloud_api" : "baileys") as "baileys" | "cloud_api",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  mutateDb((d) => {
    d.whatsappNumbers.push(number);
  });
  return ok(number);
});

on("PATCH", "/api/admin/whatsapp/numbers/:id", ({ params, body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const db = mutateDb((d) => {
    const n = d.whatsappNumbers.find((x) => x.id === params.id);
    if (!n) return;
    if (typeof b.label === "string") n.label = b.label;
    if (typeof b.shared === "boolean") n.shared = b.shared;
    // Only one default at a time, same as the real constraint.
    if (b.isDefault === true) {
      d.whatsappNumbers.forEach((x) => (x.isDefault = x.id === params.id));
    }
    n.updatedAt = nowIso();
  });
  return ok(db.whatsappNumbers.find((x) => x.id === params.id) ?? null);
});

on("DELETE", "/api/admin/whatsapp/numbers/:id", ({ params }) => {
  mutateDb((d) => {
    d.whatsappNumbers = d.whatsappNumbers.filter((n) => n.id !== params.id);
  });
  return ok({ id: params.id, deleted: true });
});

/**
 * The pairing poll. A real Baileys link hands back a rotating QR; there's no
 * socket here, so a pending number reports itself connected on the first poll
 * rather than showing a QR that could never be scanned.
 */
on("GET", "/api/admin/whatsapp/numbers/:id/qr", ({ params }) => {
  const db = mutateDb((d) => {
    const n = d.whatsappNumbers.find((x) => x.id === params.id);
    if (n && n.status !== "connected") {
      n.status = "connected";
      n.phoneNumber = n.phoneNumber ?? "+91 98765 10099";
      n.updatedAt = nowIso();
    }
  });
  const n = db.whatsappNumbers.find((x) => x.id === params.id);
  return ok({ state: n?.status ?? "connected", phoneNumber: n?.phoneNumber ?? null, qrCodeDataUrl: null });
});

on("GET", "/api/admin/whatsapp/numbers/:id/templates", () => ok([]));

on("PATCH", "/api/admin/call-routing", ({ body }) => ok(body ?? { scope: "reception_sales" }));
on("PATCH", "/api/admin/lead-deletion", ({ body }) => ok(body ?? { autoDeleteDays: 30 }));

// ---- Misc ------------------------------------------------------------------

on("GET", "/api/calls/ringing", () => ok(null));

on("PATCH", "/api/calls/:id", ({ params, body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const db = mutateDb((d) => {
    const c = d.calls.find((x) => x.id === params.id);
    if (c && typeof b.notes === "string") c.notes = b.notes;
  });
  return ok(db.calls.find((x) => x.id === params.id) ?? null);
});

on("PATCH", "/api/message-templates/:id", ({ params, body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const db = mutateDb((d) => {
    const t = d.messageTemplates.find((x) => x.id === params.id);
    if (!t) return;
    if (typeof b.name === "string") t.name = b.name;
    if (typeof b.body === "string") t.body = b.body;
    if (typeof b.subject === "string" || b.subject === null) t.subject = b.subject as string | null;
    t.updatedAt = nowIso();
  });
  return ok(db.messageTemplates.find((x) => x.id === params.id) ?? null);
});

on("DELETE", "/api/message-templates/:id", ({ params }) => {
  mutateDb((d) => {
    d.messageTemplates = d.messageTemplates.filter((t) => t.id !== params.id);
  });
  return ok({ id: params.id, deleted: true });
});

on("PUT", "/api/staff-profiles/me", ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const me = currentUser();
  mutateDb((d) => {
    const u = d.users.find((x) => x.sub === me.sub);
    if (u && typeof b.displayName === "string") u.name = b.displayName;
    if (u && typeof b.phone === "string") u.phone = b.phone;
  });
  return ok({ keycloakId: me.sub, displayName: b.displayName ?? me.name, phone: b.phone ?? me.phone });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function parseBody(init?: RequestInit): Promise<unknown> {
  if (!init?.body) return undefined;
  if (typeof init.body === "string") {
    try {
      return JSON.parse(init.body);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Most-specific-first: a route is tried ahead of any route with more path
 * parameters, so `/api/enquiries/attention-count` wins over
 * `/api/enquiries/:id` no matter which order the two were registered in.
 * Without this, adding a literal sub-route below an existing `:id` route
 * silently routes it to the wrong handler.
 */
let sortedRoutes: Route[] | null = null;
function routesBySpecificity(): Route[] {
  // Every on() call runs at module load, so this is computed once on the
  // first request. Sort is stable, so same-specificity routes keep the order
  // they were registered in.
  sortedRoutes ??= routes.slice().sort((a, b) => a.keys.length - b.keys.length);
  return sortedRoutes;
}

export async function handleMockRequest(url: string, method: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  const pathname = u.pathname;
  const body = await parseBody(init);

  for (const route of routesBySpecificity()) {
    if (route.method !== method) continue;
    const match = route.regex.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(match[i + 1]!)));
    try {
      const result = await route.handler({ params, query: u.searchParams, body });
      const payload = result.raw ? result.data : { data: result.data, ...(result.meta ?? {}) };
      return new Response(JSON.stringify(payload), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { code: "DEMO_ERROR", message: err instanceof Error ? err.message : "Demo handler error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Generic safety-net fallback: never let an unmocked /api/** path fall
  // through to a real network request (there's no backend to receive it on
  // Vercel). List-shaped GETs return an empty list; writes echo the body
  // back with a fresh id so optimistic UI doesn't break.
  if (method === "GET") {
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (method === "DELETE") {
    return new Response(JSON.stringify({ data: { success: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const echo = body && typeof body === "object" ? { ...(body as object), id: newId("demo") } : { id: newId("demo") };
  return new Response(JSON.stringify({ data: echo }), { status: 200, headers: { "Content-Type": "application/json" } });
}
