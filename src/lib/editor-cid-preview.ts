/**
 * Showing `cid:` images inside the rich editor.
 *
 * Email bodies store images as `<img src="cid:{documentId}">` — the reference
 * mail-html.ts turns into an embedded MIME part at send time. That form only
 * means something inside an email: a browser cannot load `cid:`, so every
 * image in the editor rendered as a broken icon, including the logo in a
 * footer that was in fact sending perfectly well.
 *
 * The editor therefore shows each such image through the file route and
 * converts back before handing HTML to its caller, so what is stored and sent
 * never changes:
 *
 *   stored   <img src="cid:ID">
 *   editor   <img src="/api/files/ID?inline=1&preview=1" data-cid="ID">
 *
 * Plain string transforms rather than DOM parsing so both directions are
 * testable without a browser. They only ever touch <img> tags carrying a
 * document id, which the editor itself produced.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function previewUrl(documentId: string): string {
  return `/api/files/${documentId}?inline=1&preview=1`;
}

/** Stored HTML -> what the editor should display. */
export function cidToPreview(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = new RegExp(`\\bsrc\\s*=\\s*(["'])cid:(${UUID})\\1`, "i").exec(tag);
    if (!m || /\bdata-cid\s*=/i.test(tag)) return tag;
    const id = m[2].toLowerCase();
    return tag.replace(m[0], `src="${previewUrl(id)}" data-cid="${id}"`);
  });
}

/** What the editor holds -> HTML safe to store and send. */
export function previewToCid(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = new RegExp(`\\sdata-cid\\s*=\\s*(["'])(${UUID})\\1`, "i").exec(tag);
    if (!m) return tag;
    const id = m[2].toLowerCase();
    return tag
      .replace(m[0], "")
      .replace(/\bsrc\s*=\s*(["'])[^"']*\1/i, `src="cid:${id}"`);
  });
}
