"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Upload,
  FileText,
  Image as ImageIcon,
  Download,
  Eye,
  Trash2,
  Loader2,
} from "lucide-react";
import { Button, Select, Badge, Dialog, Input } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";

export type DocScope =
  | { kind: "general" }
  | { kind: "guest"; guestId: string }
  | { kind: "enquiry"; enquiryId: string };

interface DocDTO {
  id: string;
  filename: string;
  mimeType: string;
  category: string;
  sizeBytes: number;
  inline: boolean;
  createdAt: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  medical: "Medical",
  consent: "Consent",
  operational: "Operational",
  marketing: "Marketing",
  private: "Private",
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DocumentManager({
  scope,
  canDelete = false,
  compact = false,
}: {
  scope: DocScope;
  canDelete?: boolean;
  compact?: boolean;
}) {
  const [docs, setDocs] = useState<DocDTO[]>([]);
  const [readable, setReadable] = useState<string[]>([]);
  const [uploadable, setUploadable] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [uploadCategory, setUploadCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  // A file of this name is already here — ask before overwriting it.
  const [clash, setClash] = useState<{ file: File; existing: DocDTO; rename: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DocDTO | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const scopeQuery = useCallback(() => {
    const p = new URLSearchParams();
    if (scope.kind === "general") p.set("scope", "general");
    if (scope.kind === "guest") p.set("guestId", scope.guestId);
    if (scope.kind === "enquiry") p.set("enquiryId", scope.enquiryId);
    if (filter) p.set("category", filter);
    return p.toString();
  }, [scope, filter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDocs(await api.get<DocDTO[]>(`/api/files?${scopeQuery()}`));
    } finally {
      setLoading(false);
    }
  }, [scopeQuery]);

  useEffect(() => {
    api
      .get<{ readable: string[]; uploadable: string[] }>("/api/files/meta")
      .then((m) => {
        setReadable(m.readable);
        setUploadable(m.uploadable);
        setUploadCategory((c) => c || m.uploadable[0] || "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** The scope every request in this component is filed under. */
  const scopeFields =
    scope.kind === "guest"
      ? { guestId: scope.guestId }
      : scope.kind === "enquiry"
        ? { enquiryId: scope.enquiryId }
        : {};

  /** Is a file of this name already filed here? Asked BEFORE uploading, so a
   *  staff member decides what happens without waiting for the bytes to go up
   *  first. The server enforces the same rule again on confirm — this is the
   *  prompt, not the guarantee. */
  async function findByName(name: string): Promise<DocDTO | null> {
    const params = new URLSearchParams({ filename: name });
    if (scope.kind === "general") params.set("scope", "general");
    if (scope.kind === "guest") params.set("guestId", scope.guestId);
    if (scope.kind === "enquiry") params.set("enquiryId", scope.enquiryId);
    const hits = await api.get<DocDTO[]>(`/api/files?${params}`).catch(() => [] as DocDTO[]);
    return hits.find((d) => d.filename === name) ?? null;
  }

  /** "Report.pdf" already taken -> "Report (2).pdf", skipping any name that
   *  is also taken, so the suggested rename is one the staff member can
   *  accept without hitting the same dialog again. */
  async function suggestName(name: string): Promise<string> {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 2; n < 100; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!(await findByName(candidate))) return candidate;
    }
    return name;
  }

  /** Upload the bytes and file them. `replaceDocumentId` overwrites the file
   *  already under this name instead of adding a second one. */
  async function upload(file: File, filename: string, replaceDocumentId?: string) {
    const mimeType = file.type || "application/octet-stream";
    const { url, storageKey } = await api.post<{ url: string; storageKey: string }>(
      "/api/files/upload-url",
      {
        filename,
        mimeType,
        category: uploadCategory,
        sizeBytes: file.size, // F39: bind the upload size into the presigned PUT
        ...scopeFields,
      },
    );

    // Direct browser PUT to MinIO/S3.
    const put = await fetch(url, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": mimeType },
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);

    await api.post("/api/files/confirm", {
      storageKey,
      filename,
      mimeType,
      category: uploadCategory,
      sizeBytes: file.size,
      ...scopeFields,
      ...(replaceDocumentId ? { replaceDocumentId } : {}),
    });
    await load();
  }

  async function onFile(file: File) {
    if (!uploadCategory) return;
    setUploading(true);
    setError(null);
    try {
      const existing = await findByName(file.name);
      if (existing) {
        // Hand the decision to the staff member rather than guessing. Nothing
        // has been uploaded yet, so cancelling costs nothing.
        setClash({ file, existing, rename: await suggestName(file.name) });
        return;
      }
      await upload(file, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /** "Replace" — overwrite the existing file, keeping its place in the
   *  library so anything already pointing at it now serves the new version. */
  async function resolveClashByReplacing() {
    if (!clash) return;
    const { file, existing } = clash;
    setClash(null);
    setUploading(true);
    setError(null);
    try {
      await upload(file, existing.filename, existing.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  /** "Save as" — keep both, under a name that isn't taken. */
  async function resolveClashByRenaming() {
    if (!clash) return;
    const { file, rename } = clash;
    const name = rename.trim();
    if (!name) return;
    setUploading(true);
    setError(null);
    try {
      if (await findByName(name)) {
        setError(`"${name}" is taken too. Pick another name.`);
        return;
      }
      setClash(null);
      await upload(file, name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await fetch(`/api/files/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      await load();
    } finally {
      setDeletingBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Two category pickers sit on this bar and used to look identical:
            this one FILTERS the list, the one by the Upload button sets the
            category the next upload is filed under. Labelling them is the
            whole fix — an unlabelled pair reads as a duplicate, and picking
            the wrong one silently files a document in the wrong place. */}
        {readable.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Show
            <Select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-40"
              aria-label="Filter documents by category"
            >
              <option value="">All categories</option>
              {readable.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c] ?? c}
                </option>
              ))}
            </Select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          {uploadable.length > 0 && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Upload as
                <Select
                  value={uploadCategory}
                  onChange={(e) => setUploadCategory(e.target.value)}
                  className="w-36"
                  aria-label="Category for the next upload"
                >
                  {uploadable.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c] ?? c}
                    </option>
                  ))}
                </Select>
              </label>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              />
              <Button
                onClick={() => fileRef.current?.click()}
                disabled={uploading || !uploadCategory}
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Upload
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* List */}
      <div className="overflow-hidden rounded-lg border border-border">
        {loading ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : docs.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No documents yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
          {/* table-fixed + max-w-0 on the filename cell: in an auto-layout table a
              nowrap cell contributes its full min-content width, so `truncate`
              never engages and long filenames scroll the list sideways. */}
          <table className="w-full table-fixed text-sm">
            <tbody>
              {docs.map((d) => {
                const Icon = d.mimeType.startsWith("image/") ? ImageIcon : FileText;
                return (
                  <tr key={d.id} className="border-b border-border last:border-0 hover:bg-secondary/40">
                    <td className="w-full max-w-0 px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Icon className="h-4 w-4 shrink-0 text-brand-600" />
                        <span className="truncate font-medium">{d.filename}</span>
                      </div>
                    </td>
                    {!compact && (
                      <td className="w-28 px-3 py-2.5">
                        <Badge className="bg-secondary text-secondary-foreground">
                          {CATEGORY_LABEL[d.category] ?? d.category}
                        </Badge>
                      </td>
                    )}
                    <td className="w-20 whitespace-nowrap px-3 py-2.5 text-muted-foreground">{humanSize(d.sizeBytes)}</td>
                    {!compact && (
                      <td className="w-32 whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                        {formatIST(d.createdAt, {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                    )}
                    <td className="w-32 px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {d.inline && (
                          <a
                            href={`/api/files/${d.id}?inline=1`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Preview"
                            className="rounded-md p-1.5 hover:bg-secondary"
                          >
                            <Eye className="h-4 w-4" />
                          </a>
                        )}
                        <a
                          href={`/api/files/${d.id}`}
                          title="Download"
                          className="rounded-md p-1.5 hover:bg-secondary"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                        {canDelete && (
                          <button
                            onClick={() => setDeleting(d)}
                            title="Delete"
                            className="rounded-md p-1.5 text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <Dialog
        open={!!clash}
        onClose={() => setClash(null)}
        title="That name is already taken"
        className="md:max-w-md"
      >
        <div className="p-4 md:p-5">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{clash?.existing.filename}</span> is
            already here, uploaded {clash ? formatIST(clash.existing.createdAt) : ""}.
          </p>

          <div className="mt-4 space-y-3">
            <div className="rounded-md border border-border p-3">
              <p className="text-sm font-medium">Replace it</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The new file takes its place. Anything already using this file — auto-replies,
                broadcasts, sent messages — serves the new version from now on.
              </p>
              <Button
                className="mt-2"
                onClick={resolveClashByReplacing}
                disabled={uploading}
              >
                Replace
              </Button>
            </div>

            <div className="rounded-md border border-border p-3">
              <p className="text-sm font-medium">Keep both</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Save this upload under a different name.
              </p>
              <div className="mt-2 flex gap-2">
                <Input
                  value={clash?.rename ?? ""}
                  onChange={(e) =>
                    setClash((c) => (c ? { ...c, rename: e.target.value } : c))
                  }
                  aria-label="New file name"
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  onClick={resolveClashByRenaming}
                  disabled={uploading || !clash?.rename.trim()}
                >
                  Save as
                </Button>
              </div>
            </div>
          </div>

          {error && (
            <p className="mt-3 text-sm text-destructive">{error}</p>
          )}

          <div className="mt-4 flex justify-end">
            <Button variant="outline" onClick={() => setClash(null)} disabled={uploading}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete document"
        className="md:max-w-sm"
      >
        <div className="p-4 md:p-5">
          <p className="text-sm text-muted-foreground">
            Permanently delete <span className="font-medium text-foreground">{deleting?.filename}</span>?
            This cannot be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={deletingBusy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deletingBusy}>
              {deletingBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
