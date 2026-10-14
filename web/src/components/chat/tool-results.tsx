// web/src/components/chat/tool-results.tsx — what a tool card shows under its header, one renderer per ResultView kind
// from @core/ui/tool-view: plain result lines, collapsible command output, numbered diffs, todo steps, a new file's first
// lines and a running subagent's progress. All text is React text (tool output is untrusted).
import { memo, useId, useMemo, useState, type ReactNode } from "react";

import type { Todo } from "@core/tools/types";
import type { ColorKey, Line } from "@core/ui/tool-view";

import { parsePatch, type DiffRow } from "@/components/chat/diff";
import { VisibleText } from "@/components/chat/visible-text";
import { TaskSteps, type TaskStepStatus } from "@/components/interior/task-steps";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** tool-view's colour keys → palette classes (all AA on white; "subtle" is text too, so it stays ink-3). */
const COLOR: Record<ColorKey, string> = {
  text: "text-ink",
  muted: "text-ink-3",
  subtle: "text-ink-3",
  accent: "text-accent-ink",
  success: "text-ok",
  danger: "text-error",
  warning: "text-warn",
};

export function SegmentLine({ line, baseClassName }: { line: Line; baseClassName?: string }) {
  return (
    <span className={cn("block min-h-[1lh]", baseClassName)}>
      {line.map((segment, i) => (
        <span key={i} className={cn(segment.color && COLOR[segment.color], segment.bold && "font-semibold text-ink")}>
          {segment.text}
        </span>
      ))}
    </span>
  );
}

/** Result lines in the card's body type (summaries such as "Read 84 lines", "Declined"). */
export function Lines({ lines, className }: { lines: Line[]; className?: string }) {
  return (
    <div className={cn("text-[13px] leading-relaxed text-ink-2", className)}>
      {lines.map((line, i) => (
        <SegmentLine key={i} line={line} />
      ))}
    </div>
  );
}

function ExpandToggle({ open, hidden, controls, onToggle, label }: { open: boolean; hidden: number; controls: string; onToggle: () => void; label?: string }) {
  const word = hidden === 1 ? "line" : "lines";
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="group mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[12px] font-medium text-ink-2 outline-none transition-colors duration-150 hover:bg-paper-2 hover:text-ink focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] -ml-2"
    >
      <span className={cn("inline-flex transition-transform duration-200 ease-interior", open && "rotate-180")}>
        <Icon name="chevron-down" size="sm" />
      </span>
      {open ? "Show less" : (label ?? `+${hidden} ${word}`)}
    </button>
  );
}

type OutputProps = {
  lines: Line[];
  /** Lines shown while collapsed; 0 hides the block until expanded. */
  collapsed?: number;
  /** Toggle text while collapsed, instead of "+N lines". */
  label?: string;
  tone?: "default" | "error";
};

/** Monospace tool output in a well: the first `collapsed` lines, then a "+N lines" expander (Bash, errors, raw output). */
export function OutputBlock({ lines, collapsed = 3, label, tone = "default" }: OutputProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = open ? lines : lines.slice(0, collapsed);
  const hidden = lines.length - Math.min(lines.length, collapsed);
  return (
    <div>
      {shown.length > 0 ? (
        <pre
          id={id}
          className={cn(
            "scroll-quiet max-h-[420px] overflow-auto rounded-[8px] border px-3 py-2 font-mono text-[12px] leading-[1.6] whitespace-pre",
            tone === "error" ? "border-error/15 bg-error-wash/60 text-error" : "border-rule bg-paper shadow-well text-ink-2",
          )}
        >
          {shown.map((line, i) => (
            <SegmentLine key={i} line={line} />
          ))}
        </pre>
      ) : (
        <span id={id} hidden />
      )}
      {hidden > 0 ? <ExpandToggle open={open} hidden={hidden} controls={id} onToggle={() => setOpen((v) => !v)} label={label} /> : null}
    </div>
  );
}

// ───────────────────────── Diff ─────────────────────────

const DIFF_ROWS = 24;

function DiffLine({ row, visible }: { row: Exclude<DiffRow, { kind: "hunk" }>; visible: boolean }) {
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  return (
    <div className="chat-diff-row" data-kind={row.kind}>
      <span className="no">{row.oldNo ?? ""}</span>
      <span className="no">{row.newNo ?? ""}</span>
      <span className="sign" aria-label={row.kind === "add" ? "added" : row.kind === "del" ? "removed" : undefined}>
        {sign}
      </span>
      <span className="code">{visible ? <VisibleText text={row.text} /> : row.text}</span>
    </div>
  );
}

type DiffProps = {
  patch: string;
  /** Rows shown before "Show all"; Infinity shows everything. */
  maxRows?: number;
  /** Make hidden characters visible (permission previews). */
  visible?: boolean;
  label?: string;
  className?: string;
};

/** A unified patch with old/new line numbers and green/red line backgrounds. */
export const DiffBlock = memo(function DiffBlock({ patch, maxRows = DIFF_ROWS, visible = false, label = "Diff", className }: DiffProps) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = open ? rows : rows.slice(0, maxRows);
  const hidden = rows.length - shown.length;
  const widest = rows.reduce((n, r) => (r.kind === "hunk" ? n : Math.max(n, r.oldNo ?? 0, r.newNo ?? 0)), 0);
  const gutter = `${Math.max(2, String(widest).length) + 1.5}ch`;
  return (
    <div className={className}>
      <div
        id={id}
        role="group"
        aria-label={label}
        className="chat-diff scroll-quiet overflow-x-auto rounded-[8px] border border-rule bg-surface"
        style={{ ["--diff-gutter" as string]: gutter }}
      >
        <div className="w-max min-w-full py-1">
          {shown.map((row) =>
            row.kind === "hunk" ? (
              <div key={row.key} className="chat-diff-hunk">
                <span aria-hidden>@@</span> {row.text}
              </div>
            ) : (
              <DiffLine key={row.key} row={row} visible={visible} />
            ),
          )}
        </div>
      </div>
      {hidden > 0 || open ? <ExpandToggle open={open} hidden={hidden} controls={id} onToggle={() => setOpen((v) => !v)} label={`Show all ${rows.length} lines`} /> : null}
    </div>
  );
});

// ───────────────────────── Todos ─────────────────────────

const TODO_STATUS: Record<Todo["status"], TaskStepStatus> = { completed: "done", in_progress: "active", pending: "pending" };

/** A todo list as Interior Task Steps. `animate` is false for older snapshots, so only the live list spins. */
export function TodoSteps({ todos, animate }: { todos: Todo[]; animate: boolean }) {
  const steps = todos.map((todo, i) => ({ id: `${i}:${todo.content}`, label: todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content }));
  const statuses = todos.map((todo) => (todo.status === "in_progress" && !animate ? "pending" : TODO_STATUS[todo.status]));
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div>
      <p className="mb-1 text-[12px] text-ink-3">
        {done} of {todos.length} done
      </p>
      <TaskSteps steps={steps} current={0} statuses={statuses} label="Todos" />
    </div>
  );
}

// ───────────────────────── Write preview, agent ─────────────────────────

/** A new file: its summary, then its first lines numbered from 1. */
export function WritePreview({ summary, lines, more }: { summary: Line; lines: string[]; more: number }) {
  const width = String(lines.length + more).length;
  return (
    <div>
      <Lines lines={[summary]} />
      {lines.length > 0 ? (
        <pre className="scroll-quiet mt-1.5 overflow-x-auto rounded-[8px] border border-rule bg-paper px-3 py-2 font-mono text-[12px] leading-[1.6] text-ink-2 shadow-well">
          {lines.map((line, i) => (
            <span key={i} className="block min-h-[1lh] whitespace-pre">
              <span aria-hidden className="mr-3 inline-block text-right text-ink-3 select-none" style={{ width: `${width}ch` }}>
                {i + 1}
              </span>
              {line}
            </span>
          ))}
        </pre>
      ) : null}
      {more > 0 ? <p className="mt-1.5 text-[12px] text-ink-3">+{more} more {more === 1 ? "line" : "lines"}</p> : null}
    </div>
  );
}

/** A running subagent: what it does now, and how many tools it has started. */
export function AgentProgress({ progress, toolUses }: { progress?: string; toolUses: number }) {
  return (
    <div className="flex items-center gap-2.5 text-[13px]">
      <span className="text-accent-ink">
        <Icon name="loader-circle" size="sm" motion="spin" active />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">{progress ?? "Starting…"}</span>
      <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-3">
        {toolUses} {toolUses === 1 ? "tool use" : "tool uses"}
      </span>
    </div>
  );
}

export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-[12px] font-medium text-warn">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
