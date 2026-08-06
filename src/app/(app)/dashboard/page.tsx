"use client";

import { useEffect, useState } from "react";
import {
  TrendingUp,
  Users,
  CalendarCheck,
  Trophy,
  Percent,
} from "lucide-react";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/app/page-header";
import { STAGES, STAGE_MAP } from "@/lib/kanban";
import { formatINR } from "@/lib/utils";
import { getDb, subscribe } from "@/lib/demo/store";
import type { EnquiryStage } from "@/lib/demo/types";

/**
 * DEMO BRANCH: main's dashboard/page.tsx is a Server Component that queries
 * Prisma directly — there's no server-side DB here, and the aggregate data
 * lives in the browser's localStorage-backed demo store, so this reads it
 * client-side instead. Same stat cards / layout as main.
 */
export default function DashboardPage() {
  const [tick, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((t) => t + 1)), []);

  const db = getDb();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const enquiries = db.enquiries;
  const total = enquiries.length;
  const thisMonth = enquiries.filter((e) => new Date(e.createdAt) >= monthStart).length;
  const byStage = new Map<EnquiryStage, number>();
  const bySource = new Map<string, number>();
  let revenue = 0;
  for (const e of enquiries) {
    byStage.set(e.stage, (byStage.get(e.stage) ?? 0) + 1);
    bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
    if ((e.stage === "booking_confirmed" || e.stage === "converted") && e.quotedPriceINR) {
      revenue += e.quotedPriceINR;
    }
  }
  const stageCount = (s: EnquiryStage) => byStage.get(s) ?? 0;
  const won = stageCount("booking_confirmed") + stageCount("converted");
  const lost = stageCount("lost");
  const conversion = total ? Math.round((won / total) * 100) : 0;
  const maxStage = Math.max(1, ...STAGES.map((s) => stageCount(s.id)));
  const sourceEntries = Array.from(bySource.entries()).sort((a, b) => b[1] - a[1]);
  const maxSource = Math.max(1, ...sourceEntries.map(([, c]) => c));

  const stats = [
    { label: "Total Leads", value: total, icon: Users, tint: "text-brand-600" },
    { label: "This Month", value: thisMonth, icon: CalendarCheck, tint: "text-teal-600" },
    { label: "Won (booked/converted)", value: won, icon: Trophy, tint: "text-brand-700" },
    { label: "Conversion Rate", value: `${conversion}%`, icon: Percent, tint: "text-indigo-600" },
    { label: "Booked Revenue", value: formatINR(revenue), icon: TrendingUp, tint: "text-emerald-600" },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Bird's-eye view of the pipeline. Numbers reflect all leads."
      />
      <div className="space-y-6 p-4 md:p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {stats.map((s) => (
            <Card key={s.label} className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {s.label}
                </span>
                <s.icon className={`h-5 w-5 ${s.tint}`} />
              </div>
              <div className="mt-2 break-words text-xl font-semibold text-foreground md:text-2xl">
                {s.value}
              </div>
            </Card>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-5">
            <h3 className="mb-4 text-sm font-semibold text-foreground">
              Pipeline by stage
            </h3>
            <div className="space-y-2.5">
              {STAGES.map((s) => {
                const c = stageCount(s.id);
                return (
                  <div key={s.id} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-xs text-muted-foreground md:w-44">
                      {s.label}
                    </span>
                    <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className={`h-full ${s.accent}`}
                        style={{ width: `${(c / maxStage) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-sm font-medium">{c}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="mb-4 text-sm font-semibold text-foreground">
              Leads by source
            </h3>
            <div className="space-y-2.5">
              {sourceEntries.map(([source, count]) => (
                <div key={source} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs capitalize text-muted-foreground">
                    {source.replace("_", " ")}
                  </span>
                  <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-brand-500"
                      style={{ width: `${(count / maxSource) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-sm font-medium">{count}</span>
                </div>
              ))}
              {sourceEntries.length === 0 && (
                <p className="text-sm text-muted-foreground">No data yet.</p>
              )}
            </div>
            <div className="mt-4 flex gap-4 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>
                Lost: <b className="text-foreground">{lost}</b>
              </span>
              <span>
                In progress:{" "}
                <b className="text-foreground">{total - won - lost}</b>
              </span>
            </div>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground">
          Stage labels follow the Meridian sales flow ·{" "}
          {STAGE_MAP.new_lead.label} → {STAGE_MAP.converted.label}
        </p>
      </div>
    </div>
  );
}
