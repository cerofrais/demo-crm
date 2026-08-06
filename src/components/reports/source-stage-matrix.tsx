"use client";

import { Card } from "@/components/ui";
import { STAGES } from "@/lib/kanban";

export interface MatrixRow {
  source: string;
  stage: string;
  count: number;
}

export const SOURCES = [
  "website_form",
  "whatsapp",
  "instagram",
  "facebook",
  "referral",
  "walk_in",
  "phone",
  "other",
] as const;

export function SourceStageMatrix({ rows }: { rows: MatrixRow[] }) {
  const cell = (src: string, stage: string) =>
    rows.find((r) => r.source === src && r.stage === stage)?.count ?? 0;
  const rowTotal = (src: string) =>
    rows.filter((r) => r.source === src).reduce((a, r) => a + r.count, 0);
  const colTotal = (stage: string) =>
    rows.filter((r) => r.stage === stage).reduce((a, r) => a + r.count, 0);
  const grandTotal = rows.reduce((a, r) => a + r.count, 0);

  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-foreground">Source × stage matrix</h2>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-brand-700 text-left text-xs font-semibold uppercase tracking-wide text-white">
              <th className="sticky left-0 z-10 bg-brand-700 px-4 py-3">Source</th>
              {STAGES.map((s) => (
                <th key={s.id} className="px-3 py-3 text-center">
                  {s.label}
                </th>
              ))}
              <th className="px-4 py-3 text-center">Total</th>
            </tr>
          </thead>
          <tbody>
            {SOURCES.map((src) => (
              <tr key={src} className="border-b border-border last:border-0">
                <td className="sticky left-0 z-10 bg-card px-4 py-2.5 font-medium capitalize">
                  {src.replace("_", " ")}
                </td>
                {STAGES.map((s) => {
                  const v = cell(src, s.id);
                  return (
                    <td
                      key={s.id}
                      className={`px-3 py-2.5 text-center ${
                        v ? "font-medium text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {v}
                    </td>
                  );
                })}
                <td className="px-4 py-2.5 text-center font-semibold">{rowTotal(src)}</td>
              </tr>
            ))}
            <tr className="bg-secondary/60 font-semibold">
              <td className="sticky left-0 z-10 bg-secondary px-4 py-3">Total</td>
              {STAGES.map((s) => (
                <td key={s.id} className="px-3 py-3 text-center">
                  {colTotal(s.id)}
                </td>
              ))}
              <td className="px-4 py-3 text-center">{grandTotal}</td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}
