"use client";

import { Loader2 } from "lucide-react";
import { Card, Avatar } from "@/components/ui";

export interface PerformanceRow {
  sub: string;
  name: string;
  leadsCreated: number;
  stageChanges: number;
  notes: number;
  messages: number;
  docsUploaded: number;
  conversions: number;
}

export function PerformanceTable({ rows, loading }: { rows: PerformanceRow[]; loading: boolean }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Front-office performance</h3>
      </div>
      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        /* 6 columns need ~600px: scroll horizontally on phone instead of
           clipping the Conversions column out of reach. */
        <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/60 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Staff</th>
              <th className="px-3 py-3 text-center">Leads created</th>
              <th className="px-3 py-3 text-center">Stage moves</th>
              <th className="px-3 py-3 text-center">Remarks</th>
              <th className="px-3 py-3 text-center">Docs</th>
              <th className="px-3 py-3 text-center">Conversions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sub} className="border-b border-border last:border-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Avatar name={r.name} className="h-7 w-7 text-[10px]" />
                    <span className="font-medium">{r.name}</span>
                  </div>
                </td>
                <td className="px-3 py-3 text-center">{r.leadsCreated}</td>
                <td className="px-3 py-3 text-center">{r.stageChanges}</td>
                <td className="px-3 py-3 text-center">{r.notes}</td>
                <td className="px-3 py-3 text-center">{r.docsUploaded}</td>
                <td className="px-3 py-3 text-center font-semibold text-brand-700">
                  {r.conversions}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  No activity in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      )}
    </Card>
  );
}
