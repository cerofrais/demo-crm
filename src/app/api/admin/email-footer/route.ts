/**
 * GET  /api/admin/email-footer — the signature appended to every outgoing email.
 * PUT  /api/admin/email-footer — replace it.
 *
 * Read is open to anyone who may see templates (it is not sensitive — it is
 * what every guest already receives); writing is leads.manage, the same bar
 * as editing a template.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission, ApiError } from "@/lib/api";
import { getEmailFooter, saveEmailFooter } from "@/lib/email-footer";
import { sanitizeEmailHtml } from "@/lib/mail-html";

export const dynamic = "force-dynamic";

/** The size a footer may be once cleaned — it is copied onto every message. */
const MAX_FOOTER_HTML = 20_000;

const schema = z.object({
  enabled: z.boolean(),
  // Only a sanity bound on the request itself. The real limit is applied
  // AFTER sanitizing, below: a signature copied out of Gmail carries a pile of
  // inline styles and wrapper spans the sanitizer throws away, so judging the
  // raw paste rejected footers that were small once cleaned.
  html: z.string().max(1_000_000),
  text: z.string().max(5_000),
});

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "templates.view"]);
    return ok(await getEmailFooter());
  });
}

export async function PUT(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    const input = schema.parse(await req.json());

    // A pasted image arrives as an inline data: URI. The sanitizer would strip
    // it without a word and the logo would simply be missing from every email,
    // so say so instead. The editor now converts these on paste; this catches
    // anything that reaches the API another way.
    if (/<img\b[^>]*\bsrc\s*=\s*["']?\s*data:/i.test(input.html)) {
      throw new ApiError(
        "PASTED_IMAGE",
        "An image in the footer was pasted in as raw data rather than uploaded. Remove it and add it again with the image button so it is embedded properly.",
        400,
      );
    }

    const cleanLength = sanitizeEmailHtml(input.html).length;
    if (cleanLength > MAX_FOOTER_HTML) {
      throw new ApiError(
        "FOOTER_TOO_LARGE",
        `The footer is ${cleanLength.toLocaleString("en-IN")} characters after cleanup; the limit is ${MAX_FOOTER_HTML.toLocaleString("en-IN")}. It is added to every email, so keep it to a signature.`,
        400,
      );
    }

    return ok(await saveEmailFooter({ ...input, updatedBy: ctx.sub }));
  });
}
