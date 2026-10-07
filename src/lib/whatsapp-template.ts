/**
 * Reading what an approved Meta template actually needs before we can send
 * it. Shared by every composer that offers templates — the broadcast one and
 * the follow-up scheduler — because getting this wrong doesn't degrade
 * gracefully: Meta rejects the whole message with a 400 and nothing reaches
 * the guest.
 */

export interface TemplateLike {
  components: { type: string; format?: string; text?: string }[];
}

/** True when the template's HEADER requires media — the send fails outright
 *  without one (Meta rejects the whole message, see docs/17). */
export function templateNeedsHeaderImage(t: TemplateLike): boolean {
  return t.components.some((c) => c.type === "HEADER" && c.format === "IMAGE");
}

/**
 * A template's BODY placeholders, in order of first appearance — either
 * positional ({{1}}, {{2}}, …) or named ({{customer_name}}, …). Meta never
 * mixes the two within one template, so one non-numeric token is enough to
 * treat the whole template as named — matters because named params need a
 * `parameter_name` sent alongside each value, positional ones don't (see
 * broadcast.ts / whatsapp-cloud-api.ts).
 */
export function templateBodyParams(t: TemplateLike): { names: string[]; isNamed: boolean } {
  const body = t.components.find((c) => c.type === "BODY")?.text ?? "";
  const tokens = [...body.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]);
  const unique = Array.from(new Set(tokens));
  const isNamed = unique.some((tok) => !/^\d+$/.test(tok));
  const names = isNamed ? unique : unique.sort((a, b) => Number(a) - Number(b));
  return { names, isNamed };
}
