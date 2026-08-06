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
import { DEMO_USERS } from "./seed";
import { readClientSessionCookie } from "./session";
import type {
  DemoData,
  DemoEnquiry,
  DemoGuest,
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
  };
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
      meta: a.metadata,
    }));
  return [...notes, ...activities].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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
  let list = db.enquiries.slice();
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

on("POST", "/api/enquiries/:id/tags", ({ params, body }) => {
  const { add, remove } = body as { add?: string; remove?: string };
  const db = mutateDb((d) => {
    const e = d.enquiries.find((x) => x.id === params.id);
    if (!e) return;
    if (add && !e.tags.includes(add)) e.tags.push(add);
    if (remove) e.tags = e.tags.filter((t) => t !== remove);
  });
  const e = db.enquiries.find((x) => x.id === params.id);
  return ok(e ? toEnquiryDTO(db, e) : null);
});

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

on("POST", "/api/enquiries/:id/doctor-decision", ({ params, body }) => {
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
    enquiryCount: db.enquiries.filter((e) => e.guestId === g.id).length,
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
    enquiries: db.enquiries.filter((e) => e.guestId === g.id).map((e) => toEnquiryDTO(db, e)),
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
  for (const e of db.enquiries) if (e.campaignLabel) labels.add(e.campaignLabel);
  return ok(Array.from(labels).sort());
});

on("GET", "/api/reports/performance", () => {
  const db = getDb();
  const rows = DEMO_USERS.filter((u) => u.role === "SALES" || u.role === "RECEPTION" || u.role === "MANAGER").map((u) => {
    const owned = db.enquiries.filter((e) => e.assignedToSub === u.sub);
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
  for (const e of db.enquiries) {
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
on("GET", "/api/files", () => ok([]));

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

export async function handleMockRequest(url: string, method: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  const pathname = u.pathname;
  const body = await parseBody(init);

  for (const route of routes) {
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
