"use client";

/**
 * Folding a duplicate card into the one you are looking at.
 *
 * The lead in the drawer is always the survivor — you merge INTO what you are
 * working on — because that is the card the rep has already decided to keep.
 * Before anything moves, the dialog says exactly what will come across, and it
 * says that the other card is only hidden, not destroyed: the last person who
 * tidied a duplicate here did it by deleting the other lead, and its WhatsApp
 * history and a call went with it.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, GitMerge, Loader2, Search } from "lucide-react";
import { Button, Dialog, Input } from "@/components/ui";
import { api } from "@/lib/client";
import type { EnquiryDTO } from "@/lib/types";
import { stageLabel } from "@/lib/kanban";
import { formatIST } from "@/lib/utils";

interface MergePreview {
  messages: number;
  calls: number;
  notes: number;
  tasks: number;
  documents: number;
  guestFields: string[];
  sameGuest: boolean;
}

export function MergeLeadDialog({
  target,
  onClose,
  onMerged,
}: {
  target: EnquiryDTO;
  onClose: () => void;
  onMerged: () => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<EnquiryDTO[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<EnquiryDTO | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced so typing a name does not fire a search per keystroke.
  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .get<EnquiryDTO[]>(`/api/enquiries?q=${encodeURIComponent(q)}`)
        .then((rows) => setResults(rows.filter((r) => r.id !== target.id)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [term, target.id]);

  const choose = useCallback(
    async (lead: EnquiryDTO) => {
      setPicked(lead);
      setPreview(null);
      setError(null);
      try {
        setPreview(await api.get<MergePreview>(`/api/enquiries/${target.id}/merge?from=${lead.id}`));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't read that lead.");
      }
    },
    [target.id],
  );

  async function merge() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/enquiries/${target.id}/merge`, { sourceEnquiryId: picked.id });
      onMerged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't merge those leads.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Merge a duplicate into this lead" className="md:max-w-lg">
      <div className="space-y-4 px-4 py-5 md:px-6">
        <p className="text-sm text-muted-foreground">
          Everything on the other card — WhatsApp, email, calls, remarks, tasks and files — moves onto{" "}
          <span className="font-medium text-foreground">{target.guest.fullName}</span>. The other card is hidden, not
          deleted, and the merge can be undone.
        </p>

        {!picked ? (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Find the duplicate by name, phone or email…"
                className="pl-8"
                autoFocus
              />
            </div>

            {searching && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching…
              </p>
            )}
            {results?.length === 0 && !searching && (
              <p className="text-sm text-muted-foreground">No other lead matches that.</p>
            )}
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {results?.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => choose(r)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-muted"
                >
                  <span className="text-sm font-medium">{r.guest.fullName}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.guest.phone ?? r.guest.email ?? "no contact"} · {stageLabel(r.stage)} ·{" "}
                    {r.assignedToName ?? "unassigned"} · created {formatIST(r.createdAt, { day: "numeric", month: "short" })}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-border px-3 py-2">
              <p className="text-sm font-medium">{picked.guest.fullName}</p>
              <p className="text-xs text-muted-foreground">
                {picked.guest.phone ?? picked.guest.email ?? "no contact"} · {stageLabel(picked.stage)} ·{" "}
                {picked.assignedToName ?? "unassigned"}
              </p>
            </div>

            {!preview ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking what would move…
              </p>
            ) : (
              <div className="space-y-1.5 rounded-md bg-muted/50 px-3 py-2 text-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What moves across</p>
                <ul className="space-y-0.5">
                  <li>{preview.messages} message{preview.messages === 1 ? "" : "s"} (WhatsApp and email)</li>
                  <li>{preview.calls} call{preview.calls === 1 ? "" : "s"}, with recordings</li>
                  <li>{preview.notes} remark{preview.notes === 1 ? "" : "s"}</li>
                  <li>{preview.tasks} task{preview.tasks === 1 ? "" : "s"}</li>
                  <li>{preview.documents} file{preview.documents === 1 ? "" : "s"}</li>
                  {preview.guestFields.length > 0 && (
                    <li>
                      and this lead gains their {preview.guestFields.join(", ")}
                    </li>
                  )}
                </ul>
                {preview.sameGuest && (
                  <p className="text-xs text-muted-foreground">
                    Both cards are already the same person, so their WhatsApp and email are shared — the calls and
                    remarks are what move.
                  </p>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                setPicked(null);
                setPreview(null);
              }}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              Pick a different lead
            </button>
          </div>
        )}

        {error && (
          <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={merge} disabled={!picked || !preview || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
            Merge into this lead
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
