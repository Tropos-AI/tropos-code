/** ProgressBar — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/progress-bar). Adapted for Tropos Code: lazy `m` components, shared CROSSFADE/INSTANT, app reduced-motion hook, palette tokens, no dark variants, plus a compact one-row variant and a fill tone. */
import { useId, type AriaAttributes } from "react";
import { m } from "motion/react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CROSSFADE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

const FILL = { type: "spring", stiffness: 210, damping: 34, mass: 0.9 } as const;

const BAR = "rounded-[2px] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(28,25,23,0.2)]";

/** Tropos Code: the fill colour can signal pressure (e.g. a context window filling up). */
const TONE = { accent: "bg-accent", warn: "bg-warn", error: "bg-error" } as const;
export type ProgressTone = keyof typeof TONE;

export type ProgressBarProps = {
  /** Current value, or `null` for an indeterminate (shimmering) bar. */
  value: number | null;
  max?: number;
  label?: string;
  pendingLabel?: string;
  completeLabel?: string;
  /** compact: one row (label · bar · percent) for toolbars. */
  variant?: "default" | "compact";
  tone?: ProgressTone;
  className?: string;
};

export function ProgressBar({
  value,
  max = 100,
  label = "Progress",
  pendingLabel = "Working",
  completeLabel = "Complete",
  variant = "default",
  tone = "accent",
  className,
}: ProgressBarProps) {
  const reduced = usePrefersReducedMotion();
  const labelId = useId();

  const indeterminate = value === null;
  const fraction = value === null || max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const percent = Math.round(fraction * 100);
  const complete = !indeterminate && fraction >= 1;

  const measured: AriaAttributes = indeterminate
    ? {}
    : {
        "aria-valuenow": Math.round(fraction * max * 100) / 100,
        "aria-valuetext": `${percent}%`,
      };

  const fill = cn(BAR, TONE[tone]);

  if (variant === "compact") {
    return (
      <div className={cn("flex w-full items-center gap-2", className)}>
        <span id={labelId} className="shrink-0 text-[11.5px] font-medium text-ink-2">
          {label}
        </span>
        <div
          role="progressbar"
          aria-labelledby={labelId}
          aria-valuemin={0}
          aria-valuemax={max}
          {...measured}
          className="min-w-0 flex-1 rounded-[3px] bg-rule/60 p-[1.5px] shadow-[inset_0_1px_2px_rgba(28,25,23,0.1),inset_0_0_0_1px_rgba(28,25,23,0.06)]"
        >
          <div className="relative h-[5px] overflow-hidden rounded-[2px]">
            <m.span
              aria-hidden
              className={cn("absolute inset-0 block origin-left", fill)}
              initial={false}
              animate={{ scaleX: indeterminate ? 0 : fraction }}
              transition={reduced ? INSTANT : FILL}
            />
          </div>
        </div>
        <span aria-hidden className="w-[3.2ch] shrink-0 text-right font-mono text-[11px] font-medium tabular-nums text-ink-2">
          {indeterminate ? "–" : `${percent}%`}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span id={labelId} className="truncate text-[13px] font-medium text-ink-2">
          {label}
        </span>

        <span aria-hidden className="grid shrink-0 justify-items-end text-ink-3">
          <m.span
            className="col-start-1 row-start-1 whitespace-nowrap text-[12px] font-medium leading-5"
            initial={false}
            animate={{ opacity: indeterminate ? 1 : 0 }}
            transition={reduced ? INSTANT : CROSSFADE}
          >
            {pendingLabel}
          </m.span>

          <m.span
            className="col-start-1 row-start-1 whitespace-nowrap font-mono text-[12px] font-medium leading-5 tabular-nums"
            initial={false}
            animate={{ opacity: indeterminate ? 0 : 1 }}
            transition={reduced ? INSTANT : CROSSFADE}
          >
            {percent}%
          </m.span>
        </span>
      </div>

      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={max}
        {...measured}
        className="mt-2 rounded-[4px] bg-rule/60 p-[2px] shadow-[inset_0_1px_2px_rgba(28,25,23,0.1),inset_0_0_0_1px_rgba(28,25,23,0.06)]"
      >
        <div className="relative h-[8px] overflow-hidden rounded-[2px]">
          <m.span
            aria-hidden
            className={cn("absolute inset-0 block origin-left", fill)}
            initial={false}
            animate={{ scaleX: indeterminate ? 0 : fraction }}
            transition={reduced ? INSTANT : FILL}
          />

          {indeterminate && !reduced ? (
            <m.span
              aria-hidden
              className={cn("absolute inset-y-0 left-0 block w-2/5", fill)}
              initial={{ x: "-100%", opacity: 0 }}
              animate={{ x: "250%", opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                x: { duration: 1.25, ease: "easeInOut", repeat: Infinity },
                opacity: { duration: 0.18 },
              }}
            />
          ) : null}
        </div>
      </div>

      <span aria-live="polite" className="sr-only">
        {complete ? completeLabel : indeterminate ? pendingLabel : ""}
      </span>
    </div>
  );
}

export default ProgressBar;
