// web/src/components/agents/live-activity.tsx — the Agents page's live pieces: the state pill on each card, what a
// running agent is doing (its tool or last lines, its model, its chat), its last run once idle, the page's "2 running"
// count and the org-chart connectors between the chief and its specialists. Motion stays off under reduced motion.
import type { AgentRunView } from "@core/agents/activity";

import { ago } from "@/components/agents/specialist-detail";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import type { LiveState } from "@/lib/agent-activity";
import { cn } from "@/lib/utils";

const LIVE: Record<LiveState, { tone: "off" | "accent" | "warn"; label: string; dot: string }> = {
  idle: { tone: "off", label: "Idle", dot: "bg-ink-4" },
  working: { tone: "accent", label: "Working", dot: "bg-accent motion-safe:animate-pulse-dot" },
  waiting: { tone: "warn", label: "Waiting for approval", dot: "bg-warn motion-safe:animate-pulse-dot" },
};

/** Idle, working or waiting for approval: always a word, the dot only pulses while something happens. */
export function LiveBadge({ state, className }: { state: LiveState; className?: string }) {
  const live = LIVE[state];
  return (
    <Badge tone={live.tone} dot={false} className={className}>
      <span aria-hidden className={cn("size-1.5 rounded-full", live.dot)} />
      {live.label}
    </Badge>
  );
}

/** The header's count of running agents; announced politely when it changes. */
export function RunningCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span role="status" className="inline-flex h-8 items-center gap-2 rounded-[9px] border border-accent/15 bg-accent-wash px-2.5 font-mono text-[12px] text-accent-ink shadow-well">
      <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse-dot" />
      {count} running
    </span>
  );
}

/** One running agent: where it runs and on which model, then its current tool or the last lines it wrote. */
export function RunLine({ run, showChat }: { run: AgentRunView; showChat: boolean }) {
  const doing = run.tool ?? run.text;
  return (
    <div className="min-w-0 rounded-[10px] border border-rule bg-paper/70 px-3 py-2 shadow-well">
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono text-[11.5px] text-ink-3">
        {showChat && run.session.chat ? (
          <>
            <span className="text-ink-2">{run.session.chat}</span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <span className="truncate">{run.model}</span>
      </p>
      {run.task ? <p className="mt-1 line-clamp-1 text-[12.5px] text-ink-2">{run.task}</p> : null}
      <p className="mt-1 flex min-w-0 items-start gap-1.5 text-[12.5px] leading-snug text-ink">
        {run.tool ? (
          <>
            <span aria-hidden className="mt-[3px] shrink-0 text-ink-3">
              <Icon name="terminal" size="sm" />
            </span>
            <span className="min-w-0 break-words font-mono text-[12px]">{run.tool}</span>
          </>
        ) : doing ? (
          <span className="min-w-0 whitespace-pre-line break-words">{doing}</span>
        ) : (
          <span className="text-ink-3">Thinking…</span>
        )}
      </p>
    </div>
  );
}

/** "Last run: 5 minutes ago · LGTM", once an agent is idle again. */
export function LastRunLine({ at, result, ok }: { at: number; result: string; ok: boolean }) {
  return (
    <p className={cn("line-clamp-2 text-[12px] leading-snug", ok ? "text-ink-3" : "text-error")}>
      Last run: {ago(at)} · {result || (ok ? "done" : "failed")}
    </p>
  );
}

/**
 * One specialist's piece of the org chart, drawn inside its card's <li>: a stroke of the trunk and an elbow with a
 * rounded corner into the card at its avatar. A trunk stroke starts at the chief card (first child) or overlaps the
 * row above by a pixel, and either runs on past the row's bottom or stops where its own elbow curves away (last
 * child), so the trunk is one unbroken line at every width. Offsets are from the <li>'s padding box: the list has
 * pt-5 and gap-3, the card a 1px border, and the avatar's centre sits 33px down.
 */
export function OrgConnector({ from, to }: { from: "chief" | "sibling"; to: "next" | "elbow" }) {
  return (
    <>
      <span
        aria-hidden="true"
        data-connector="trunk"
        data-from={from}
        data-to={to}
        className={cn(
          "pointer-events-none absolute left-[-21px] w-0.5 bg-rule-strong",
          from === "chief" ? "top-[-21px]" : "top-[-13px]",
          to === "next" ? "bottom-[-2px]" : from === "chief" ? "h-[46px]" : "h-[38px]",
        )}
      />
      <span aria-hidden="true" data-connector="elbow" className="pointer-events-none absolute left-[-21px] top-[23px] h-[11px] w-5 rounded-bl-[10px] border-b-2 border-l-2 border-rule-strong" />
    </>
  );
}
