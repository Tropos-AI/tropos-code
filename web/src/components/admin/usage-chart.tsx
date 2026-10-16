// web/src/components/admin/usage-chart.tsx — the Usage page's charts, hand-built from CSS boxes: stacked daily token
// columns (input in the accent, output in its soft tint) and horizontal per-model bars. The daily chart is one
// role="img" with a text summary; a visually hidden table carries every number for assistive tech.
import { useMemo, useState } from "react";
import { m } from "motion/react";

import type { UsageDay, UsageSummary } from "@core/web/admin/api";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, INSTANT } from "@/lib/springs";
import { formatCompact, formatDay, formatUsd } from "@/lib/ops-format";
import { cn } from "@/lib/utils";

export function chartSummary(days: UsageDay[]): string {
  if (days.length === 0) return "No usage in this range.";
  const total = (d: UsageDay) => d.inputTokens + d.outputTokens;
  const sum = days.reduce((n, d) => n + total(d), 0);
  const peak = days.reduce((best, d) => (total(d) > total(best) ? d : best), days[0]!);
  return `Tokens per day from ${formatDay(days[0]!.date)} to ${formatDay(days[days.length - 1]!.date)}: ${formatCompact(sum)} in total, busiest on ${formatDay(peak.date)} with ${formatCompact(total(peak))}.`;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const n = value / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

export function DailyChart({ days }: { days: UsageDay[] }) {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const max = useMemo(() => niceMax(Math.max(0, ...days.map((d) => d.inputTokens + d.outputTokens))), [days]);
  const summary = chartSummary(days);
  const shown = active !== null ? days[active] : undefined;
  const ticks = days.length > 0 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : [];

  return (
    <figure className="m-0">
      <div className="flex min-h-[2.5rem] flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-2" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-accent" /> Input
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-accent-soft" /> Output
        </span>
        <span className="ml-auto font-mono tabular-nums text-ink">
          {shown ? `${formatDay(shown.date)} · ${formatCompact(shown.inputTokens)} in · ${formatCompact(shown.outputTokens)} out · ${formatUsd(shown.costUsd)}` : `peak scale ${formatCompact(max)}`}
        </span>
      </div>
      <div role="img" aria-label={summary} className="relative mt-1 h-44 border-b border-rule" onPointerLeave={() => setActive(null)}>
        {[0.5, 1].map((f) => (
          <span key={f} aria-hidden className="absolute inset-x-0 border-t border-dashed border-rule" style={{ bottom: `${f * 100}%` }}>
            <span className="absolute -top-2 left-0 bg-surface pr-1 font-mono text-[10.5px] tabular-nums text-ink-3">{formatCompact(max * f)}</span>
          </span>
        ))}
        <div className="absolute inset-0 flex items-end gap-px pl-9">
          {days.map((day, i) => {
            const inH = (day.inputTokens / max) * 100;
            const outH = (day.outputTokens / max) * 100;
            return (
              <div key={day.date} className={cn("group relative flex h-full min-w-0 flex-1 flex-col justify-end", active === i && "bg-accent-wash/70")} onPointerEnter={() => setActive(i)}>
                <m.div
                  className="flex w-full origin-bottom flex-col justify-end"
                  style={{ height: `${inH + outH}%` }}
                  initial={reduced ? false : { scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={reduced ? INSTANT : { ...CELL, delay: Math.min(i * 0.006, 0.3) }}
                >
                  <span className="block w-full rounded-t-[2px] bg-accent-soft" style={{ height: `${(outH / (inH + outH || 1)) * 100}%` }} />
                  <span className="block w-full bg-accent" style={{ height: `${(inH / (inH + outH || 1)) * 100}%` }} />
                </m.div>
              </div>
            );
          })}
        </div>
      </div>
      <div aria-hidden className="relative mt-1.5 flex justify-between pl-9 font-mono text-[11px] text-ink-3">
        {ticks.map((i) => (
          <span key={i}>{formatDay(days[i]!.date)}</span>
        ))}
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
      <table className="sr-only">
        <caption>Daily usage</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Sessions</th>
            <th scope="col">Input tokens</th>
            <th scope="col">Output tokens</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{d.date}</th>
              <td>{d.sessions}</td>
              <td>{d.inputTokens}</td>
              <td>{d.outputTokens}</td>
              <td>{formatUsd(d.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function ModelBars({ models }: { models: UsageSummary["byModel"] }) {
  const reduced = usePrefersReducedMotion();
  const sorted = useMemo(() => [...models].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)), [models]);
  const max = Math.max(1, ...sorted.map((r) => r.inputTokens + r.outputTokens));
  return (
    <ul className="flex flex-col gap-3.5" aria-label="Usage by model">
      {sorted.map((row) => {
        const total = row.inputTokens + row.outputTokens;
        return (
          <li key={row.model} className="grid gap-1.5">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{row.model}</span>
              <span className="font-mono text-[12px] tabular-nums text-ink-2">
                {formatCompact(row.inputTokens)} in · {formatCompact(row.outputTokens)} out
              </span>
              <span className="w-16 text-right font-mono text-[12.5px] tabular-nums text-ink" title={row.costUsd === undefined ? "No known price for this model" : undefined}>
                {formatUsd(row.costUsd)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-paper-2 shadow-well" aria-hidden>
              <m.div
                className="flex h-full origin-left overflow-hidden rounded-full"
                style={{ width: `${(total / max) * 100}%` }}
                initial={reduced ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={reduced ? INSTANT : CELL}
              >
                <span className="h-full bg-accent" style={{ width: `${total ? (row.inputTokens / total) * 100 : 0}%` }} />
                <span className="h-full bg-accent-soft" style={{ width: `${total ? (row.outputTokens / total) * 100 : 0}%` }} />
              </m.div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
