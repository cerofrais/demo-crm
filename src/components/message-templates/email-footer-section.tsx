"use client";

import { useEffect, useState } from "react";
import { Loader2, PenLine } from "lucide-react";
import { Card, Button, Textarea, RichTextEditor } from "@/components/ui";
import { api } from "@/lib/client";
import { uploadLibraryImage } from "@/components/messaging/upload-library-image";

interface FooterDTO {
  enabled: boolean;
  html: string;
  text: string;
  updatedAt: string | null;
}

/**
 * The signature appended to every outgoing email.
 *
 * Two halves on purpose. The rich half is what almost everyone sees; the
 * plain half is what a text-only reader gets, and it is written separately
 * rather than stripped from the HTML so it can say "trewellness.in" where
 * the HTML shows a logo — a stripped version would render as a blank line.
 */
export function EmailFooterSection({ canManage }: { canManage: boolean }) {
  const [footer, setFooter] = useState<FooterDTO | null>(null);
  const [html, setHtml] = useState("");
  const [text, setText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<FooterDTO>("/api/admin/email-footer")
      .then((f) => {
        setFooter(f);
        setHtml(f.html);
        setText(f.text);
        setEnabled(f.enabled);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load the footer"));
  }, []);

  const dirty =
    footer !== null && (html !== footer.html || text !== footer.text || enabled !== footer.enabled);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<FooterDTO>("/api/admin/email-footer", { enabled, html, text });
      setFooter(next);
      setHtml(next.html);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the footer");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PenLine className="h-4 w-4 text-brand-600" />
          <h2 className="text-sm font-semibold text-foreground">Email footer</h2>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canManage}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-input accent-brand-600"
          />
          Add to every outgoing email
        </label>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Appended to every email the CRM sends — replies, bulk email and the welcome message.
        Images are embedded in the message itself, so they still show months later.
      </p>

      {footer === null && !error ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Formatted
          </label>
          <RichTextEditor
            html={html}
            onChange={setHtml}
            disabled={!canManage}
            onUploadImage={canManage ? uploadLibraryImage : undefined}
            placeholder="Trē Wellness · An Integrative Wellness Retreat · trewellness.in"
          />

          <label className="mb-1 mt-3 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Plain text
          </label>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!canManage}
            rows={3}
            className="text-sm"
            placeholder={"Trē Wellness — An Integrative Wellness Retreat\ntrewellness.in · +91 87126 23064"}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Shown to readers whose client blocks HTML. Worth writing out any link the formatted
            version only shows as a logo.
          </p>

          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

          {canManage && (
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={saving || !dirty}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save footer
              </Button>
              {saved && <span className="text-xs text-emerald-600">Saved</span>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
