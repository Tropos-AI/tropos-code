/** ValueFlash — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/value-flash). Adapted for Tropos Code: lazy `m` components, shared CELL/CROSSFADE/INSTANT, app reduced-motion hook, ok/error tokens, arrow Icon instead of inline SVG triangles, no dark variants. */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";

import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, CROSSFADE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

const ROLL = { type: "spring", stiffness: 460, damping: 32, mass: 0.55 } as const;
const POP = { type: "spring", stiffness: 640, damping: 22, mass: 0.7 } as const;
const LIFT = { type: "spring", stiffness: 380, damping: 26, mass: 0.7 } as const;

const CLEAR = { duration: 0.16, ease: [0.4, 0, 1, 1] } as const;
const DROP = { duration: 0.14, ease: [0.4, 0, 1, 1] } as const;

export type FlashDirection = "up" | "down";

export type UseValueFlashOptions<T> = {
  /** How long the flash holds, in ms. */
  hold?: number;
  /** Signed comparison for non-numeric values (> 0 means up). */
  compare?: (next: T, previous: T) => number;
};

export type ValueFlashState<T> = {
  direction: FlashDirection | null;
  from: T;
  changeId: number;
  flashing: boolean;
};

/** Tracks the direction of the latest change of `value` and flags a short flash window after it. */
export function useValueFlash<T>(value: T, { hold = 900, compare }: UseValueFlashOptions<T> = {}): ValueFlashState<T> {
  const [state, setState] = useState<ValueFlashState<T>>({
    direction: null,
    from: value,
    changeId: 0,
    flashing: false,
  });

  const previous = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rank = useRef(compare);

  useEffect(() => {
    rank.current = compare;
  });

  useEffect(() => {
    const prior = previous.current;
    if (Object.is(prior, value)) return;
    previous.current = value;

    const measure = rank.current;
    const delta = measure
      ? measure(value, prior)
      : typeof value === "number" && typeof prior === "number"
        ? value - prior
        : 0;

    if (delta === 0) return;

    setState((prev) => ({
      direction: delta > 0 ? "up" : "down",
      from: prior,
      changeId: prev.changeId + 1,
      flashing: true,
    }));

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setState((prev) => (prev.flashing ? { ...prev, flashing: false } : prev));
    }, hold);
  }, [value, hold]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return state;
}

export type ValueFlashProps = {
  value: number;
  format?: (value: number) => string;
  /** Prefix for the screen-reader announcement ("Requests per second: 1,284"). */
  label?: string;
  hold?: number;
  /** Debounce for the live-region announcement, in ms. */
  announceAfter?: number;
  className?: string;
};

export function ValueFlash({ value, format, label, hold = 900, announceAfter = 700, className }: ValueFlashProps) {
  const { direction, flashing, changeId } = useValueFlash(value, { hold });
  const reduced = usePrefersReducedMotion();

  const text = format ? format(value) : String(value);
  const [settled, setSettled] = useState(text);

  useEffect(() => {
    const id = setTimeout(() => setSettled(text), announceAfter);
    return () => clearTimeout(id);
  }, [text, announceAfter]);

  const tone = flashing ? (direction === "up" ? "text-ok" : "text-error") : "text-ink-2";
  const tint = direction === "up" ? "bg-ok/[0.12]" : "bg-error/[0.12]";

  return (
    <m.span
      initial={false}
      animate={{ scale: reduced ? 1 : flashing ? 1.05 : 1 }}
      transition={reduced ? INSTANT : flashing ? LIFT : CROSSFADE}
      className={cn(
        "relative inline-grid grid-flow-col items-center gap-1.5 rounded-[6px] px-1.5 py-[3px] text-[13px] font-medium tabular-nums transition-colors duration-200",
        tone,
        className,
      )}
    >
      {direction ? (
        <m.span
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: flashing ? 1 : 0 }}
          transition={reduced ? INSTANT : flashing ? CELL : CLEAR}
          className={cn("pointer-events-none absolute inset-0 rounded-[6px]", tint)}
        />
      ) : null}

      <span aria-hidden className="relative inline-grid overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          <m.span
            key={changeId}
            initial={
              reduced
                ? { opacity: 0 }
                : { opacity: 0, y: direction === "down" ? "-0.85em" : "0.85em", filter: "blur(5px)" }
            }
            animate={{ opacity: 1, y: "0em", filter: "blur(0px)" }}
            exit={
              reduced
                ? { opacity: 0, transition: INSTANT }
                : { opacity: 0, y: direction === "down" ? "0.7em" : "-0.7em", filter: "blur(4px)", transition: DROP }
            }
            transition={reduced ? INSTANT : ROLL}
            className="col-start-1 row-start-1"
          >
            {text}
          </m.span>
        </AnimatePresence>
      </span>
      <span aria-hidden className="relative grid size-3.5 place-items-center">
        <AnimatePresence initial={false}>
          {flashing && direction ? (
            <m.span
              key={`${changeId}-${direction}`}
              initial={
                reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4, y: direction === "up" ? "0.3em" : "-0.3em" }
              }
              animate={{ opacity: 1, scale: 1, y: "0em" }}
              exit={reduced ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.8, transition: CLEAR }}
              transition={reduced ? INSTANT : POP}
              className="col-start-1 row-start-1 grid place-items-center"
            >
              <Icon name={direction === "up" ? "arrow-up" : "arrow-down"} size="sm" />
            </m.span>
          ) : null}
        </AnimatePresence>
      </span>
      <span className="sr-only" aria-live="polite">
        {label ? `${label}: ${settled}` : settled}
      </span>
    </m.span>
  );
}

export default ValueFlash;
