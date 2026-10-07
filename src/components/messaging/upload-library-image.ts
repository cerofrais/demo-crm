/**
 * Upload an image and return its Document id, for RichTextEditor's image
 * button.
 *
 * The editor inserts `<img src="cid:{id}">` and mail-html.ts turns that into
 * a real inline MIME part at send time — the image travels inside the
 * message rather than being fetched from a URL. That matters here because
 * this deployment has no publicly reachable file host: MinIO sits behind
 * presigned links that expire, and the app itself is only exposed to the
 * internet on three webhook paths. A linked image would fail for every
 * recipient; an embedded one still renders months later.
 *
 * Filed under "marketing" because a template or footer image is a shared
 * asset, not a document belonging to any one guest.
 */
import { api } from "@/lib/client";

const CATEGORY = "marketing";

export async function uploadLibraryImage(file: File): Promise<string | null> {
  try {
    const mimeType = file.type || "application/octet-stream";
    const { url, storageKey } = await api.post<{ url: string; storageKey: string }>(
      "/api/files/upload-url",
      { filename: file.name, mimeType, category: CATEGORY, sizeBytes: file.size },
    );
    const put = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": mimeType } });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    const confirmed = await api.post<{ id: string }>("/api/files/confirm", {
      storageKey,
      filename: file.name,
      mimeType,
      category: CATEGORY,
      sizeBytes: file.size,
    });
    return confirmed.id;
  } catch {
    // The editor shows nothing rather than a broken image; the author can
    // retry. Swallowed because there is no error surface in the toolbar.
    return null;
  }
}
