/** Task Steps — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/task-steps). Adapted for Tropos Code: lazy `m`, shared CELL/INSTANT and reduced-motion hook, ok/error/ink tokens, Icon check/x/loader-circle in place of inline SVGs. */

import { useEffect, useState } from "react";
import { AnimatePresence, m } from "motion/react";

import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

const POP = { type: "spring", stiffness: 640, damping: 22, mass: 0.7 } as const;
const SPIN = { duration: 0.8, ease: "linear", repeat: Infinity } as const;
const SHIMMER = { duration: 1.6, ease: "linear", repeat: Infinity } as const;

export type TaskStep = {
  id: string;
  label: string;
  /** Shown once the step is done, e.g. its duration. */
  meta?: string;
};

export type TaskStepStatus = "pending" | "active" | "done" | "error";

export type TaskStepRow = TaskStep & { status: TaskStepStatus };

export type UseTaskStepsOptions = {
  steps: TaskStep[];
  /** Index of the running step; `steps.length` means everything is done. */
  current: number;
  /** Marks the current step as failed. */
  failed?: boolean;
  /** Tropos Code: explicit per-step statuses (a todo list need not finish in order); overrides `current`/`failed`. */
  statuses?: readonly TaskStepStatus[];
};

export type UseTaskStepsResult = {
  rows: TaskStepRow[];
  complete: boolean;
  failed: boolean;
  /** A one-line summary for screen readers. */
  sentence: string;
};

export function useTaskSteps({ steps, current, failed: failedProp = false, statuses }: UseTaskStepsOptions): UseTaskStepsResult {
  const failed = statuses ? statuses.includes("error") : failedProp;
  const complete = statuses ? steps.length > 0 && steps.every((_, i) => statuses[i] === "done") : !failed && current >= steps.length;

  const rows = steps.map((step, i): TaskStepRow => {
    const status: TaskStepStatus = statuses
      ? (statuses[i] ?? "pending")
      : i < current ? "done" : i === current && failed ? "error" : i === current && !complete ? "active" : "pending";
    return { ...step, status };
  });

  const active = rows.find((r) => r.status === "active");
  const activeIndex = active ? rows.indexOf(active) : current;
  const failedRow = rows.find((r) => r.status === "error");
  const sentence = failed
    ? `Failed at ${failedRow?.label ?? steps[Math.min(current, steps.length - 1)]?.label ?? "step"}`
    : complete
      ? `All ${steps.length} steps complete`
      : active
        ? `${active.label}, step ${activeIndex + 1} of ${steps.length}`
        : "";

  return { rows, complete, failed, sentence };
}

export type TaskStepsProps = UseTaskStepsOptions & {
  label?: string;
  className?: string;
};

const TONE: Record<TaskStepStatus, string> = {
  done: "text-ink-2",
  active: "font-medium text-ink",
  error: "font-medium text-error",
  pending: "text-ink-3",
};

export function TaskSteps({ steps, current, failed = false, statuses, label = "Task progress", className }: TaskStepsProps) {
  const { rows, complete, sentence } = useTaskSteps({ steps, current, failed, statuses });
  const reduced = usePrefersReducedMotion();

  const [spoken, setSpoken] = useState("");
  useEffect(() => {
    if (!sentence) return;
    const t = setTimeout(() => setSpoken(sentence), 500);
    return () => clearTimeout(t);
  }, [sentence]);

  return (
    <div className={cn("w-full", className)}>
      <ol aria-label={label} className="space-y-0.5">
        {rows.map((row) => (
          <li
            key={row.id}
            aria-current={row.status === "active" ? "step" : undefined}
            className="flex h-7 items-center gap-2.5 px-1"
          >
            <span className="relative grid size-4 shrink-0 place-items-center">
              <AnimatePresence initial={false}>
                {row.status === "done" ? (
                  <m.span
                    key="done"
                    className="col-start-1 row-start-1 grid size-4 place-items-center rounded-[5px] bg-ok-wash text-ok"
                    initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, transition: INSTANT }}
                    transition={reduced ? INSTANT : POP}
                  >
                    <Icon name="check" size="sm" className="size-[11px]" />
                  </m.span>
                ) : row.status === "error" ? (
                  <m.span
                    key="error"
                    className="col-start-1 row-start-1 grid size-4 place-items-center rounded-[5px] bg-error-wash text-error"
                    initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, transition: INSTANT }}
                    transition={reduced ? INSTANT : POP}
                  >
                    <Icon name="x" size="sm" className="size-[10px]" />
                  </m.span>
                ) : row.status === "active" ? (
                  <m.span
                    key="active"
                    className="col-start-1 row-start-1 grid place-items-center text-ink-3"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: INSTANT }}
                    transition={reduced ? INSTANT : CELL}
                  >
                    <m.span
                      className="grid place-items-center"
                      animate={reduced ? { rotate: 0 } : { rotate: 360 }}
                      transition={reduced ? INSTANT : SPIN}
                    >
                      <Icon name="loader-circle" size="sm" className="size-3" />
                    </m.span>
                  </m.span>
                ) : (
                  <m.span
                    key="pending"
                    className="col-start-1 row-start-1 size-[5px] rounded-[2px] bg-rule-strong"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: INSTANT }}
                    transition={INSTANT}
                  />
                )}
              </AnimatePresence>
            </span>

            {row.status === "active" && !reduced ? (
              <m.span
                className="min-w-0 flex-1 truncate bg-[linear-gradient(90deg,var(--ink-3)_38%,var(--ink)_50%,var(--ink-3)_62%)] bg-clip-text text-[12.5px] font-medium text-transparent [background-size:220%_100%]"
                animate={{ backgroundPosition: ["120% 0", "-120% 0"] }}
                transition={SHIMMER}
              >
                {row.label}
              </m.span>
            ) : (
              <span className={cn("min-w-0 flex-1 truncate text-[12.5px] transition-colors duration-200", TONE[row.status])}>
                {row.label}
              </span>
            )}

            {row.meta ? (
              <span
                className={cn(
                  "shrink-0 font-mono text-[10.5px] tabular-nums transition-opacity duration-200",
                  row.status === "done" ? "text-ink-3 opacity-100" : "opacity-0",
                )}
                aria-hidden={row.status !== "done"}
              >
                {row.meta}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <span role="status" className="sr-only">
        {spoken}
      </span>
      <span className="sr-only" aria-live={complete || failed ? "polite" : "off"}>
        {complete ? "Run complete" : failed ? "Run failed" : ""}
      </span>
    </div>
  );
}

export default TaskSteps;
