/** Slider Detents — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/slider-detents). Adapted for Tropos Code: lazy `m`, shared CELL/CROSSFADE/INSTANT and reduced-motion hook, ink/rule/accent tokens, no ref writes during render. */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { m, useMotionTemplate, useSpring } from "motion/react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, CROSSFADE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

const GRAB = { type: "spring", stiffness: 700, damping: 46, mass: 0.5 } as const;
const THUMB = 18;

const plain = (value: number) => String(value);

function tidy(value: number) {
  return Math.round(value * 1e6) / 1e6;
}

export type SliderDetent = { value: number; label?: string };

const NONE: readonly (number | SliderDetent)[] = [];

export type UseSliderDetentsOptions = {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  detents?: readonly (number | SliderDetent)[];
  /** How close (in value units) the thumb must come before a detent captures it. Defaults to 4.5% of the range. */
  pull?: number;
  thumbSize?: number;
  disabled?: boolean;
  haptic?: boolean;
  format?: (value: number) => string;
  label?: string;
  labelledBy?: string;
};

export function useSliderDetents({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  detents = NONE,
  pull,
  thumbSize = THUMB,
  disabled = false,
  haptic = true,
  format = plain,
  label,
  labelledBy,
}: UseSliderDetentsOptions) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const list = useMemo<SliderDetent[]>(() => detents.map((d) => (typeof d === "number" ? { value: d } : d)), [detents]);

  const range = max - min;
  const grab = pull ?? range * 0.045;

  const emit = useRef(onValueChange);
  const emitted = useRef(value);
  useEffect(() => {
    emit.current = onValueChange;
    emitted.current = value;
  });

  const activeDetent = useMemo(() => list.findIndex((d) => tidy(d.value) === tidy(value)), [list, value]);

  const marked = useRef(activeDetent);
  const held = useRef(false);

  const commit = useCallback(
    (next: number) => {
      const settled = Math.min(max, Math.max(min, tidy(next)));
      const index = list.findIndex((d) => tidy(d.value) === settled);
      if (index !== marked.current) {
        marked.current = index;
        if (haptic && index >= 0) navigator.vibrate?.(6);
      }
      if (settled !== emitted.current) {
        emitted.current = settled;
        emit.current(settled);
      }
    },
    [haptic, list, max, min],
  );

  const capture = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || range <= 0) return null;
      const rect = el.getBoundingClientRect();
      const travel = rect.width - thumbSize;
      if (travel <= 0) return null;

      const ratio = (clientX - rect.left - thumbSize / 2) / travel;
      const raw = Math.min(max, Math.max(min, min + ratio * range));

      let index = -1;
      let nearest = grab;
      for (let i = 0; i < list.length; i += 1) {
        const distance = Math.abs(raw - list[i].value);
        if (distance <= nearest) {
          nearest = distance;
          index = i;
        }
      }
      if (index >= 0) return list[index].value;
      return min + Math.round((raw - min) / step) * step;
    },
    [grab, list, max, min, range, step, thumbSize],
  );

  const release = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    setDragging(false);
  }, []);

  const toDetent = useCallback(
    (direction: number) => {
      const sorted = list.map((d) => d.value).toSorted((a, b) => a - b);
      const forward = sorted.find((d) => d > value + 1e-6);
      const backward = sorted.findLast((d) => d < value - 1e-6);
      const target = direction > 0 ? forward : backward;
      commit(target ?? (direction > 0 ? max : min));
    },
    [commit, list, max, min, value],
  );

  useEffect(() => {
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, [release]);

  const detentLabel = list[activeDetent]?.label;
  const valueText = detentLabel ? `${format(value)}, ${detentLabel}` : format(value);

  const percent = range > 0 ? Math.min(1, Math.max(0, (value - min) / range)) : 0;

  const trackProps = {
    role: "slider" as const,
    tabIndex: 0,
    "aria-orientation": "horizontal" as const,
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuenow": value,
    "aria-valuetext": valueText,
    "aria-disabled": disabled || undefined,
    "aria-label": labelledBy ? undefined : label,
    "aria-labelledby": labelledBy,
    style: { touchAction: "none" as const },
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.currentTarget.focus({ preventScroll: true });
      held.current = true;
      setDragging(true);
      const next = capture(e.clientX);
      if (next !== null) commit(next);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!held.current) return;
      const next = capture(e.clientX);
      if (next !== null) commit(next);
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const forward = e.key === "ArrowRight" || e.key === "ArrowUp";
      const back = e.key === "ArrowLeft" || e.key === "ArrowDown";

      if (forward || back) {
        const direction = forward ? 1 : -1;
        if (e.shiftKey) toDetent(direction);
        else commit(value + direction * step);
      } else if (e.key === "PageUp") {
        toDetent(1);
      } else if (e.key === "PageDown") {
        toDetent(-1);
      } else if (e.key === "Home") {
        commit(min);
      } else if (e.key === "End") {
        commit(max);
      } else {
        return;
      }
      e.preventDefault();
    },
  };

  return {
    trackRef,
    trackProps,
    detents: list,
    activeDetent,
    percent,
    dragging,
    valueText,
  };
}

export type SliderDetentsProps = {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  detents?: readonly (number | SliderDetent)[];
  pull?: number;
  label?: string;
  format?: (value: number) => string;
  disabled?: boolean;
  haptic?: boolean;
  className?: string;
};

export function SliderDetents({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  detents = NONE,
  pull,
  label = "Value",
  format = plain,
  disabled = false,
  haptic = true,
  className,
}: SliderDetentsProps) {
  const labelId = useId();
  const reduced = usePrefersReducedMotion();

  const {
    trackRef,
    trackProps,
    detents: list,
    activeDetent,
    percent,
    dragging,
  } = useSliderDetents({
    value,
    onValueChange,
    min,
    max,
    step,
    detents,
    pull,
    disabled,
    haptic,
    format,
    labelledBy: labelId,
  });

  const carriage = useSpring(percent * 100, { stiffness: CELL.stiffness, damping: CELL.damping, mass: CELL.mass });
  const offset = useMotionTemplate`${carriage}%`;

  useEffect(() => {
    const target = percent * 100;
    if (reduced) carriage.jump(target);
    else carriage.set(target);
  }, [carriage, percent, reduced]);

  // Reserve the widest readout so the label never shifts while dragging.
  const widest = useMemo(() => {
    const options = [format(min), format(max), ...list.map((d) => (d.label ? `${format(d.value)} · ${d.label}` : format(d.value)))];
    return options.reduce((a, b) => (b.length > a.length ? b : a), "");
  }, [format, list, max, min]);

  const suffix = list[activeDetent]?.label ?? "";

  // Keep the last detent label on screen while it fades out.
  const [lastLabel, setLastLabel] = useState(suffix);
  if (suffix && suffix !== lastLabel) setLastLabel(suffix);

  const span = max - min;

  return (
    <div className={cn("w-full select-none", className)}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <span id={labelId} className="text-[12.5px] text-ink-3">
          {label}
        </span>
        <span className="grid justify-items-start">
          <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-pre font-mono text-[11px] tabular-nums">
            {widest}
          </span>
          <span aria-hidden className="col-start-1 row-start-1 whitespace-pre font-mono text-[11px] tabular-nums text-ink-2">
            {format(value)}
            <m.span
              initial={false}
              animate={{ opacity: suffix ? 1 : 0 }}
              transition={reduced ? INSTANT : CROSSFADE}
              className="text-ink-3"
            >
              {lastLabel ? ` · ${lastLabel}` : ""}
            </m.span>
          </span>
        </span>
      </div>
      <div
        ref={trackRef}
        {...trackProps}
        className={cn(
          "relative h-9 w-full rounded-[9px] outline-none focus-visible:bg-accent/[0.06] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]",
          disabled ? "pointer-events-none opacity-50" : dragging ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 top-[9px] h-[10px] overflow-hidden rounded-[5px] bg-rule">
          <div className="absolute inset-y-0" style={{ left: THUMB / 2, right: THUMB / 2 }}>
            <m.div className="absolute inset-y-0 left-0 right-0" style={{ x: offset }}>
              <div className="absolute inset-y-0 right-full w-[2000px] bg-ink" />
            </m.div>
          </div>
        </div>
        <div className="pointer-events-none absolute inset-y-0" style={{ left: THUMB / 2, right: THUMB / 2 }}>
          {list.map((d) => (
            <span
              key={String(d.value)}
              aria-hidden
              className="absolute top-[26px] block h-[5px] w-[2px] -translate-x-1/2 bg-ink/35"
              style={{ left: span > 0 ? `${((d.value - min) / span) * 100}%` : "0%" }}
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0" style={{ left: THUMB / 2, right: THUMB / 2 }}>
          <m.div className="absolute inset-y-0 left-0 right-0" style={{ x: offset }}>
            <m.div
              className="absolute top-[4px] h-[20px] w-[18px] rounded-[6px] border-2 border-surface bg-ink"
              style={{ marginLeft: -THUMB / 2 }}
              initial={false}
              animate={{ scale: dragging ? 1.08 : 1 }}
              transition={reduced ? INSTANT : GRAB}
            />
          </m.div>
        </div>
      </div>
    </div>
  );
}

export default SliderDetents;
