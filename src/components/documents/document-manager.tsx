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
import { Button, Select, Badge, Dialog } from "@/components/ui";
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

  async function onFile(file: File) {
    if (!uploadCategory) return;
    setUploading(true);
    setError(null);
    try {
      const { url, storageKey } = await api.post<{ url: string; storageKey: string }>(
        "/api/files/upload-url",
        {
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          category: uploadCategory,
          sizeBytes: file.size, // F39: bind the upload size into the presigned PUT
          ...(scope.kind === "guest" ? { guestId: scope.guestId } : {}),
          ...(scope.kind === "enquiry" ? { enquiryId: scope.enquiryId } : {}),
        },
      );

      // Direct browser PUT to MinIO/S3.
      const put = await fetch(url, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      await api.post("/api/files/confirm", {
        storageKey,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        category: uploadCategory,
        sizeBytes: file.size,
        ...(scope.kind === "guest" ? { guestId: scope.guestId } : {}),
        ...(scope.kind === "enquiry" ? { enquiryId: scope.enquiryId } : {}),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
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
        {readable.length > 1 && (
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-40">
            <option value="">All categories</option>
            {readable.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c] ?? c}
              </option>
            ))}
          </Select>
        )}
        <div className="ml-auto flex items-center gap-2">
          {uploadable.length > 0 && (
            <>
              <Select
                value={uploadCategory}
                onChange={(e) => setUploadCategory(e.target.value)}
                className="w-36"
              >
                {uploadable.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c] ?? c}
                  </option>
                ))}
              </Select>
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
