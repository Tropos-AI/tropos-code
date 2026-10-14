// web/src/components/chat/ToolCard.tsx — one tool call: a white card with the tool's icon, `Title(args)` from
// @core/ui/tool-view, a status dot, and its result (spec §5 "Tool call card").
import { memo, useMemo, type ReactNode } from "react";

import type { TranscriptItem } from "@core/ui/transcript";
import { toolView, type Line, type ResultView } from "@core/ui/tool-view";

import { AgentProgress, DiffBlock, Labelled, Lines, OutputBlock, TodoSteps, WritePreview } from "@/components/chat/tool-results";
import { toolIcon } from "@/components/chat/tool-meta";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type Status = ToolItem["status"];

const STATUS: Record<Status, { dot: string; label: string; word?: string; ink?: string }> = {
  running: { dot: "bg-accent animate-pulse-dot", label: "Running" },
  done: { dot: "bg-ok", label: "Done" },
  error: { dot: "bg-error", label: "Failed", word: "Failed", ink: "text-error" },
  denied: { dot: "bg-warn", label: "Declined", word: "Declined", ink: "text-warn" },
};

export function StatusDot({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={s.label}>
      {s.word ? <span className={cn("text-[11.5px] font-medium", s.ink)}>{s.word}</span> : <span className="sr-only">{s.label}</span>}
      <span aria-hidden className="relative grid size-2.5 place-items-center">
        {status === "running" ? <span className="absolute inset-0 rounded-full bg-accent/25" /> : null}
        <span className={cn("size-1.5 rounded-full", s.dot)} />
      </span>
    </span>
  );
}

/** The "… +N lines (ctrl+o to expand)" line tool-view adds in compact mode: the web card has its own expander. */
const isMoreLine = (line: Line) => line.length === 1 && /^… \+\d+ lines? \(ctrl\+o to expand\)$/.test(line[0]!.text);

function linesOf(view: ResultView): Line[] {
  return view.kind === "lines" ? view.lines : [];
}

/** The card body for a result, or null when the header says it all. */
function body(item: ToolItem, compact: ResultView, full: ResultView, animateTodos: boolean): ReactNode {
  switch (compact.kind) {
    case "none":
      return null;
    case "todos":
      return <TodoSteps todos={compact.todos} animate={animateTodos} />;
    case "agent-progress":
      return <AgentProgress progress={compact.progress} toolUses={compact.toolUses} />;
    case "diff":
      return (
        <div className="flex flex-col gap-1.5">
          <Lines lines={[compact.summary]} />
          <DiffBlock patch={compact.patch} label={`Changes to ${item.summary}`} />
        </div>
      );
    case "write-preview": {
      const all = full.kind === "write-preview" ? full : compact;
      return <WritePreview summary={compact.summary} lines={all.lines} more={all.more} />;
    }
    case "lines": {
      if (item.status === "denied") {
        // A plain "Declined" is already in the header; feedback or a rule's reason is worth showing.
        if (compact.lines.length === 1 && compact.lines[0]![0]?.text === "Declined") return null;
        return (
          <Labelled label={compact.lines[0]?.[0]?.color === "warning" ? "Reason" : "You said"}>
            <Lines lines={compact.lines} />
          </Labelled>
        );
      }
      if (item.status === "running") return <Lines lines={compact.lines} />;
      const fullLines = linesOf(full);
      // Raw output (Bash, errors, MCP text): the first 3 lines, then an expander for the rest.
      if (item.name === "Bash" || item.status === "error" || compact.lines.some(isMoreLine)) {
        return <OutputBlock lines={fullLines} collapsed={3} tone={item.status === "error" ? "error" : "default"} />;
      }
      // A summary ("Read 84 lines"); the output behind it opens on demand.
      const extra = fullLines.slice(compact.lines.length);
      return (
        <div>
          <Lines lines={compact.lines} />
          {extra.length > 0 ? <OutputBlock lines={extra} collapsed={0} label={`Show output · ${extra.length} ${extra.length === 1 ? "line" : "lines"}`} /> : null}
        </div>
      );
    }
  }
}

type Props = {
  item: ToolItem;
  cwd?: string;
  /** Only the newest todo list animates its active step, and only while the turn runs. */
  animateTodos?: boolean;
};

export const ToolCard = memo(function ToolCard({ item, cwd, animateTodos = false }: Props) {
  const compact = useMemo(() => toolView(item, cwd), [item, cwd]);
  const full = useMemo(() => toolView(item, cwd, { verbose: true }).result, [item, cwd]);
  const status = STATUS[item.status];
  const icon = toolIcon(item.name);
  const label = `${compact.title}${compact.args ? ` ${compact.args}` : ""} — ${status.label}`;
  const content = body(item, compact.result, full, animateTodos);

  return (
    <article aria-label={label} className="overflow-hidden rounded-[12px] border border-rule bg-surface shadow-card">
      <header className="flex min-h-10 items-center gap-2.5 px-3 py-1.5">
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-[7px] border border-rule bg-paper-2 shadow-well", item.status === "running" ? "text-accent-ink" : "text-ink-2")}>
          <Icon name={icon} size="sm" />
        </span>
        <p className="flex min-w-0 flex-1 items-baseline gap-0.5 text-[13px] leading-snug">
          <span className="shrink-0 font-medium text-ink">{compact.title}</span>
          {compact.args ? (
            <span className="min-w-0 truncate font-mono text-[12px] text-ink-2" title={compact.args}>
              ({compact.args})
            </span>
          ) : null}
        </p>
        {compact.badge ? (
          <Badge tone="violet" dot={false} className="max-w-[40%] truncate">
            {compact.badge.text}
          </Badge>
        ) : null}
        <StatusDot status={item.status} />
      </header>
      {content ? <div className="border-t border-rule/80 px-3 pb-2.5 pt-2">{content}</div> : null}
    </article>
  );
});
