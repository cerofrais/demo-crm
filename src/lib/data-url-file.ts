/**
 * Turning a pasted image back into a file the upload flow accepts.
 *
 * Lives outside the editor component so it can be tested: the suite runs
 * plain TypeScript with no JSX transform, and this is the one piece of the
 * paste handling with real edge cases worth pinning down.
 *
 * Why it exists at all: a signature copied from Gmail or a website carries its
 * logo as a `data:image/…;base64` URI. Left in the HTML that is tens of
 * thousands of characters for one small image — it broke the footer's size
 * limit — and the server sanitizer strips data: images regardless, so the logo
 * would have silently disappeared on save. The editor converts it with this
 * and uploads it as a proper embedded image instead.
 */

/** Image types every mainstream mail client renders inline. SVG is left out:
 *  Gmail and Outlook both refuse to show it. */
export const EMBEDDABLE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/i;

export function safeImageName(name: string): string {
  return (name || "image").replace(/[^\w.-]+/g, "-").slice(0, 40) || "image";
}

/** A pasted `data:image/png;base64,…` URI as a File, or null if it is not an
 *  embeddable base64 image. */
export function dataUrlToFile(dataUrl: string, name: string): File | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(dataUrl);
  if (!m || !EMBEDDABLE_IMAGE.test(m[1])) return null;
  try {
    const bin = atob(m[2].replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = m[1].split("/")[1].toLowerCase().replace("jpeg", "jpg");
    return new File([bytes], `${safeImageName(name)}.${ext}`, { type: m[1].toLowerCase() });
  } catch {
    return null;
  }
}
