import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can, canWorkLeadStage } from "@/lib/rbac";
import { listEnquiries, type EnquiryFilters } from "@/lib/enquiries";
import { createEnquiry } from "@/lib/enquiry-service";
import { createEnquirySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// GET /api/enquiries — list with filters (Kanban + table share this)
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) {
      throw new ApiError("FORBIDDEN", "No access to leads", 403);
    }
    const sp = req.nextUrl.searchParams;
    const filters: EnquiryFilters = {
      q: sp.get("q") ?? undefined,
      stage: sp.get("stage") ?? undefined,
      source: sp.get("source") ?? undefined,
      gender: sp.get("gender") ?? undefined,
      city: sp.get("city") ?? undefined,
      tag: sp.get("tag") ?? undefined,
      createdFrom: sp.get("from") ?? undefined,
      createdTo: sp.get("to") ?? undefined,
      rnrDone: sp.get("rnrDone") ?? undefined,
    };
    const assignee = sp.get("assignee");
    if (assignee === "me") filters.assignee = ctx.sub;
    else if (assignee) filters.assignee = assignee;

    let data = await listEnquiries(filters);

    // Reception/Sales see only their own + the unassigned queue to pick from.
    if (!can(ctx.roles, "leads.manage") && can(ctx.roles, "leads.ownOnly")) {
      data = data.filter(
        (e) => e.assignedToSub === ctx.sub || e.assignedToSub === null,
      );
    }
    // Sales additionally loses visibility once a lead reaches Booking
    // Confirmed — it's handed off to Reception at that point (see the
    // auto-unassign in the stage-transition routes).
    data = data.filter((e) => canWorkLeadStage(ctx.roles, e.stage));
    return ok(data, { total: data.length });
  });
}

// POST /api/enquiries — manual create (Reception/Manager/Admin)
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!(can(ctx.roles, "leads.manage") || can(ctx.roles, "leads.ownOnly"))) {
      throw new ApiError("FORBIDDEN", "Not allowed to create leads", 403);
    }
    const input = createEnquirySchema.parse(await req.json());

    // Manually created leads go to whoever created them, not the
    // round-robin/category auto-assign that inbound sources use — the
    // creator is by definition already a "known-better owner" (same
    // reasoning as call-routing's answered-call assignment), and an
    // Admin/Manager can still reassign it afterward same as any other lead.
    const result = await createEnquiry(
      { ...input, assignedTo: { sub: ctx.sub, name: ctx.name } },
      { sub: ctx.sub, name: ctx.name, role: ctx.roles[0] ?? "STAFF" },
    );
    return ok(result, undefined, 201);
  });
}
