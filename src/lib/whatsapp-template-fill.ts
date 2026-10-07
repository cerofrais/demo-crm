/**
 * Filling an approved Meta template in for one guest.
 *
 * A Cloud API number can only open a conversation with a template — free text
 * outside the 24-hour window is rejected by Meta outright. So on the 61 line
 * the template button offers Meta's own approved templates, and picking one
 * SENDS that template rather than pasting its text into the box: pasted text
 * is a free-form message, which is the thing that fails.
 *
 * What goes in the thread afterwards has to be the filled-in text, not the
 * raw template with {{1}} in it — the rep needs to read back what the guest
 * actually received.
 */

/** A placeholder with nothing supplied reads better empty than as "{{1}}". */
export function fillTemplateBody(body: string, names: string[], values: string[]): string {
  let out = body;
  names.forEach((name, i) => {
    const value = values[i] ?? "";
    out = out.split(`{{${name}}}`).join(value);
  });
  return out;
}

export type TemplateFillProblem =
  | { kind: "missing"; index: number; name: string }
  | { kind: "tooMany" }
  | null;

/**
 * Why this template cannot be sent with these values — null when it can.
 *
 * Meta rejects the whole message when the parameter count is wrong, with an
 * error that names nothing useful, so the count is checked here where the
 * template's own placeholders are in hand.
 */
export function checkTemplateValues(names: string[], values: string[]): TemplateFillProblem {
  if (values.length > names.length) return { kind: "tooMany" };
  for (let i = 0; i < names.length; i++) {
    if (!values[i]?.trim()) return { kind: "missing", index: i, name: names[i] };
  }
  return null;
}

/**
 * A first guess for each placeholder, so the common case is one click.
 *
 * Named placeholders say what they want ({{customer_name}}), and the
 * overwhelmingly common positional first parameter is the guest's name —
 * which is what every one of these templates opens with. Everything else is
 * left blank for the rep to type: a wrong guess sent to a guest is worse than
 * an empty box.
 */
export function suggestTemplateValues(names: string[], guest: { fullName?: string | null }): string[] {
  const firstName = (guest.fullName ?? "").trim().split(/\s+/)[0] ?? "";
  return names.map((name, i) => {
    const key = name.toLowerCase();
    if (key.includes("name") && !key.includes("company") && !key.includes("business")) return firstName;
    if (/^\d+$/.test(name) && i === 0) return firstName;
    return "";
  });
}
