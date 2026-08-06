"use client";

import { MessageCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui";
import { STAGE_MAP } from "@/lib/kanban";
import { formatIST } from "@/lib/utils";
import { LeadCard } from "./lead-card";
import type { EnquiryDTO } from "@/lib/types";

const SOURCE_LABEL: Record<string, string> = {
  website_form: "Website",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  referral: "Referral",
  walk_in: "Walk-in",
  phone: "Phone",
  other: "Other",
};

export function LeadsTable({
  enquiries,
  onSelect,
}: {
  enquiries: EnquiryDTO[];
  onSelect: (e: EnquiryDTO) => void;
}) {
  return (
    <>
      {/* Phone: card list (reuses the board card) */}
      <div className="space-y-2 p-3 md:hidden">
        {enquiries.map((e) => (
          <LeadCard key={e.id} enquiry={e} onClick={() => onSelect(e)} />
        ))}
        {enquiries.length === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No leads match your filters.
          </p>
        )}
      </div>

      {/* md+: full table */}
      <div className="m-4 hidden overflow-hidden rounded-xl border border-border bg-card md:block">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/60 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">City</th>
              <th className="px-4 py-3">Age</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Stage</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {enquiries.map((e) => {
              const s = STAGE_MAP[e.stage];
              return (
                <tr
                  key={e.id}
                  onClick={() => onSelect(e)}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-secondary/40"
                >
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      {e.guest.phone}
                      <MessageCircle className="h-3.5 w-3.5 text-green-600" />
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      {e.guest.fullName}
                      {(e.guest.isReturning || e.isReturningFlag) && (
                        <RefreshCw className="h-3 w-3 text-brand-600" />
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {e.guest.email ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {e.guest.city ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {e.guest.ageGroup ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge className="bg-secondary text-secondary-foreground">
                      {SOURCE_LABEL[e.source] ?? e.source}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={s?.badge ?? "bg-secondary"}>
                      {s?.label ?? e.stage}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {e.assignedToName ?? (
                      <span className="italic">Unassigned</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatIST(e.lastActivityAt, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                </tr>
              );
            })}
            {enquiries.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-12 text-center text-muted-foreground"
                >
                  No leads match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}
