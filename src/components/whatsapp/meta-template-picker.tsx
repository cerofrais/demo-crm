"use client";

/**
 * The template button on the official (Cloud API) number.
 *
 * The CRM's own templates are text a rep pastes and sends — which is exactly
 * what Meta refuses on this line once a guest has been quiet for 24 hours. So
 * on the 61 number the same button offers Meta's approved templates instead,
 * and picking one sends it AS a template: the only message that reaches a
 * cold conversation.
 *
 * Templates that are pending or rejected are listed too, greyed out with the
 * reason showing. Hiding them turns "where is the template I submitted" into
 * a mystery; showing them answers it.
 */

import { useEffect, useRef, useState } from "react";
import { ImagePlus, LayoutTemplate, Loader2, Send, X } from "lucide-react";
import { Button, Dialog, Input } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { templateBodyParams, templateNeedsHeaderImage } from "@/lib/whatsapp-template";
import { checkTemplateValues, fillTemplateBody, suggestTemplateValues } from "@/lib/whatsapp-template-fill";

export interface MetaTemplate {
  id: string;
  name: string;
  status: string;
  category: string | null;
  language: string;
  components: { type: string; format?: string; text?: string }[];
  viaMarketingApi?: boolean;
}

export interface MetaTemplateSend {
  name: string;
  language: string;
  params: string[];
  /** The picture a header-image template needs, once uploaded. */
  headerDocumentId?: string;
}

export function MetaTemplatePicker({
  numberId,
  guestName,
  disabled,
  onSend,
  uploadHeaderImage,
  openUpward = false,
  align = "right",
}: {
  numberId: string;
  guestName: string | null;
  disabled?: boolean;
  /** Sends it; the panel owns the thread, so it owns the request. */
  onSend: (t: MetaTemplateSend) => Promise<void>;
  /** Stores the chosen picture as a Document on this guest and hands back its
   *  id — the same upload path the composer's own attachments take. */
  uploadHeaderImage: (file: File) => Promise<string>;
  openUpward?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<MetaTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<MetaTemplate | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  // Re-read on a number change: templates belong to the WABA behind that
  // number, not to the CRM.
  useEffect(() => {
    setTemplates(null);
    setLoadError(null);
  }, [numberId]);

  function openPicker() {
    setOpen((o) => !o);
    if (templates === null && !loading) {
      setLoading(true);
      api
        .get<MetaTemplate[]>(`/api/admin/whatsapp/numbers/${numberId}/templates`)
        .then(setTemplates)
        .catch((err) => setLoadError(err instanceof Error ? err.message : "Couldn't load templates"))
        .finally(() => setLoading(false));
    }
  }

  const approved = (templates ?? []).filter((t) => t.status === "APPROVED");
  const others = (templates ?? []).filter((t) => t.status !== "APPROVED");

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={openPicker}
        disabled={disabled}
        title="Insert an approved WhatsApp template"
      >
        <LayoutTemplate className="h-4 w-4" />
      </Button>

      {open && (
        <div
          className={cn(
            "absolute z-20 w-72 rounded-md border border-border bg-popover shadow-lg",
            align === "left" ? "left-0" : "right-0",
            openUpward ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <p className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            WhatsApp templates
          </p>
          <div className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            )}
            {loadError && <p className="px-3 py-3 text-sm text-destructive">{loadError}</p>}
            {!loading && !loadError && templates?.length === 0 && (
              <p className="px-3 py-3 text-sm text-muted-foreground">This number has no templates yet.</p>
            )}

            {approved.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setPending(t);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left transition-colors hover:bg-secondary"
              >
                <span className="block truncate text-sm text-foreground">{t.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t.language}
                  {t.category ? ` · ${t.category.toLowerCase()}` : ""}
                </span>
              </button>
            ))}

            {others.length > 0 && (
              <>
                <p className="px-3 pb-0.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Not sendable
                </p>
                {others.map((t) => (
                  <div key={t.id} className="px-3 py-2 opacity-60" title={`Meta has this template as ${t.status}`}>
                    <span className="block truncate text-sm text-foreground">{t.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t.status.toLowerCase()}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {pending && (
        <TemplateSendDialog
          template={pending}
          guestName={guestName}
          uploadHeaderImage={uploadHeaderImage}
          onClose={() => setPending(null)}
          onSend={async (payload) => {
            await onSend(payload);
            setPending(null);
          }}
        />
      )}
    </div>
  );
}

/** Fill the placeholders, read what the guest will get, send it. */
function TemplateSendDialog({
  template,
  guestName,
  uploadHeaderImage,
  onClose,
  onSend,
}: {
  template: MetaTemplate;
  guestName: string | null;
  uploadHeaderImage: (file: File) => Promise<string>;
  onClose: () => void;
  onSend: (t: MetaTemplateSend) => Promise<void>;
}) {
  const { names } = templateBodyParams(template);
  const [values, setValues] = useState<string[]>(() => suggestTemplateValues(names, { fullName: guestName }));
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const body = template.components.find((c) => c.type === "BODY")?.text ?? "";
  const preview = fillTemplateBody(body, names, values);
  const problem = checkTemplateValues(names, values);
  const needsImage = templateNeedsHeaderImage(template);

  async function send() {
    if (problem || (needsImage && !headerFile)) return;
    setSending(true);
    setError(null);
    try {
      // Uploaded only once the rep commits to sending: picking a picture and
      // then closing the dialog should leave nothing behind on the guest.
      const headerDocumentId = needsImage && headerFile ? await uploadHeaderImage(headerFile) : undefined;
      await onSend({ name: template.name, language: template.language, params: values, headerDocumentId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that template.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={template.name} className="md:max-w-md">
      <div className="space-y-4 px-4 py-5 md:px-6">
        <>
            {/* This template puts a picture above its text, and Meta rejects
                the whole message without one — so it is chosen here. */}
            {needsImage && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Header image</label>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => setHeaderFile(e.target.files?.[0] ?? null)}
                />
                {headerFile ? (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={URL.createObjectURL(headerFile)}
                      alt={headerFile.name}
                      className="h-12 w-12 shrink-0 rounded object-cover"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs">{headerFile.name}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderFile(null);
                        if (fileRef.current) fileRef.current.value = "";
                      }}
                      disabled={sending}
                      title="Remove"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={sending}
                    className="gap-1.5"
                  >
                    <ImagePlus className="h-4 w-4" /> Choose an image
                  </Button>
                )}
              </div>
            )}

            {names.map((name, i) => (
              <div key={name} className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">{`{{${name}}}`}</label>
                <Input
                  value={values[i] ?? ""}
                  onChange={(e) => setValues((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                  disabled={sending}
                  autoFocus={i === 0}
                />
              </div>
            ))}

            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                What the guest will get
              </p>
              <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                {preview}
              </p>
            </div>

            {template.viaMarketingApi && (
              <p className="text-xs text-muted-foreground">
                Sent through Meta&rsquo;s Marketing Messages API, because this template is a marketing one.
              </p>
            )}
        </>

        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending || Boolean(problem) || (needsImage && !headerFile)}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send template
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
