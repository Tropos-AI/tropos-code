// web/src/app/pages/UsagePage.tsx — what the agent used over the last 7, 30 or 90 days: headline numbers, tokens per
// day, a breakdown by model and the most expensive sessions.
import { useState, type ReactNode } from "react";

import type { UsageSummary } from "@core/web/admin/api";

import { PanelHead, PanelStack } from "@/components/pages/panel-head";
import { hrefFor } from "@/app/routes";
import { AdminCard } from "@/components/admin/admin-parts";
import { DailyChart, ModelBars } from "@/components/admin/usage-chart";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { SegmentedControl } from "@/components/interior/segmented-control";
import { PageActions } from "@/components/pages/page-actions";
import { ResourceView } from "@/components/pages/resource-view";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCompact, formatUsd } from "@/lib/ops-format";
import { shortAge } from "@/lib/time";
import { cn } from "@/lib/utils";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

function Stat({ label, value, sub, title, className }: { label: string; value: ReactNode; sub?: ReactNode; title?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-[14px] border border-rule bg-surface p-4 shadow-card", className)} title={title}>
      <dt className="type-meta text-ink-3">{label}</dt>
      <dd className="font-mono text-[26px] font-medium leading-none tracking-[-0.02em] tabular-nums text-ink">{value}</dd>
      {sub ? <dd className="text-[12.5px] leading-snug text-ink-2">{sub}</dd> : null}
    </div>
  );
}

function UsageBody({ usage, days }: { usage: UsageSummary; days: number }) {
  const t = usage.totals;
  const empty = t.sessions === 0 && t.inputTokens + t.outputTokens === 0;
  return (
    <>
      <dl aria-label={`Totals for the last ${days} days`} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.35fr_1.35fr_1fr_1fr]">
        <Stat label="Cost" value={formatUsd(t.costUsd)} sub={t.costUsd === undefined ? "Unknown: a model without a known price took part." : `over ${days} days`} />
        <Stat label="Tokens" value={formatCompact(t.inputTokens + t.outputTokens)} sub={`${formatCompact(t.inputTokens)} in · ${formatCompact(t.outputTokens)} out`} />
        <Stat label="Sessions" value={t.sessions} />
        <Stat label="Turns" value={t.turns} />
      </dl>
      {empty ? (
        <AdminCard title="Activity" icon="bar-chart-3">
          <EmptyState icon="bar-chart-3" title="No usage in this range" description="Run a chat and its tokens and cost show up here." />
        </AdminCard>
      ) : (
        <>
          <AdminCard title="Tokens per day" icon="bar-chart-3">
            <DailyChart days={usage.byDay} />
          </AdminCard>
          <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
            <AdminCard title="By model" icon="cpu">
              {usage.byModel.length === 0 ? <p className="text-[13px] text-ink-2">No model usage recorded.</p> : <ModelBars models={usage.byModel} />}
            </AdminCard>
            <AdminCard title="Top sessions" icon="message-square" bodyClassName="p-0">
              {usage.topSessions.length === 0 ? (
                <p className="p-5 text-[13px] text-ink-2">No sessions in this range.</p>
              ) : (
                <ol className="divide-y divide-rule" aria-label="Top sessions">
                  {usage.topSessions.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                      <div className="min-w-0 flex-1">
                        <a href={hrefFor("chat")} title={`Open chat (session ${s.id})`} className="block truncate rounded-[4px] text-[13.5px] font-medium text-ink outline-none decoration-accent/40 underline-offset-[3px] hover:underline focus-visible:shadow-focus">
                          {s.title || "Untitled session"}
                        </a>
                        <p className="mt-0.5 truncate text-[12px] text-ink-3">
                          {s.project} · {shortAge(s.updatedAt) === "now" ? "just now" : `${shortAge(s.updatedAt)} ago`}
                        </p>
                      </div>
                      <div className="text-right font-mono text-[12px] tabular-nums">
                        <p className="text-ink">{formatUsd(s.costUsd)}</p>
                        <p className="text-ink-3">{formatCompact(s.tokens)} tok</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </AdminCard>
          </div>
        </>
      )}
    </>
  );
}

export function UsagePanel() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const resource = useAdminResource("usage.summary", { days });
  return (
    <PanelStack>
      <PanelHead description="Tokens and cost of every session, by day and by model." actions={<PageActions resource={resource} noun="usage" />} />
      <SegmentedControl label="Time range" options={RANGES} value={String(days)} onValueChange={(v) => setDays(Number(v) as 7 | 30 | 90)} className="w-[17rem] max-w-full" />
      <ResourceView resource={resource} noun="usage">
        {(usage) => <UsageBody usage={usage} days={days} />}
      </ResourceView>
    </PanelStack>
  );
}
