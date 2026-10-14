/**
 * Press Depth — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/press-depth).
 *
 * Adapted for Tropos Labs (then for Tropos Code: Vite, shared springs in lib/springs, Cojeev icons): renders as a link (every CTA here navigates),
 * adds a solid ink variant and a site-scale size. The press physics, pointer
 * tilt and keyboard handling are the library's usePressDepth hook.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { m } from "motion/react";

import { CELL } from "@/lib/springs";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

export type UsePressDepthOptions = {
  disabled?: boolean;
  onPressStart?: () => void;
  onPressEnd?: () => void;
};

export type PressOrigin = { x: number; y: number };

export function usePressDepth(options: UsePressDepthOptions = {}) {
  const { disabled = false, onPressStart, onPressEnd } = options;

  const [pressed, setPressed] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [origin, setOrigin] = useState<PressOrigin | null>(null);

  const node = useRef<HTMLElement | null>(null);
  const pointer = useRef<number | null>(null);
  const down = useRef(false);

  const began = useRef(onPressStart);
  const ended = useRef(onPressEnd);
  useEffect(() => {
    began.current = onPressStart;
    ended.current = onPressEnd;
  });

  const setDown = useCallback((next: boolean) => {
    if (down.current === next) return;
    down.current = next;
    setPressed(next);
    if (next) began.current?.();
    else ended.current?.();
  }, []);

  const stop = useCallback(() => {
    pointer.current = null;
    setTracking(false);
    setOrigin(null);
    setDown(false);
  }, [setDown]);

  useEffect(() => {
    if (!tracking) return;

    const contains = (event: PointerEvent) => {
      const el = node.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    };

    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointer.current) return;
      setDown(contains(event));
    };
    const lift = (event: PointerEvent) => {
      if (event.pointerId !== pointer.current) return;
      stop();
    };
    const bail = () => stop();
    const hidden = () => {
      if (document.hidden) stop();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", lift);
    window.addEventListener("pointercancel", lift);
    window.addEventListener("blur", bail);
    document.addEventListener("visibilitychange", hidden);

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", lift);
      window.removeEventListener("pointercancel", lift);
      window.removeEventListener("blur", bail);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [tracking, setDown, stop]);

  useEffect(() => {
    if (!disabled) return;
    const id = requestAnimationFrame(stop);
    return () => cancelAnimationFrame(id);
  }, [disabled, stop]);

  const ref = useCallback((next: HTMLElement | null) => {
    node.current = next;
  }, []);

  const bind = {
    onPointerDown: (event: React.PointerEvent) => {
      if (disabled) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const r = event.currentTarget.getBoundingClientRect();
      setOrigin({
        x: Math.max(-1, Math.min(1, ((event.clientX - r.left) / r.width) * 2 - 1)),
        y: Math.max(-1, Math.min(1, ((event.clientY - r.top) / r.height) * 2 - 1)),
      });
      pointer.current = event.pointerId;
      setTracking(true);
      setDown(true);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (disabled || event.repeat) return;
      if (event.key === " " || event.key === "Enter") setDown(true);
    },
    onKeyUp: (event: React.KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter" || event.key === "Escape") setDown(false);
    },
    onBlur: () => stop(),
  };

  return { pressed, origin, ref, bind };
}

type Variant = "solid" | "surface" | "primary";
type Size = "sm" | "md";

const FACE: Record<Variant, string> = {
  solid: "border-ink bg-ink text-white",
  surface: "border-rule bg-surface text-ink",
  // Tropos Code: the periwinkle primary. accent-strong keeps white text at 5.2:1.
  primary: "border-accent-strong bg-accent-strong text-white",
};

const HOVER: Record<Variant, string> = {
  solid: "group-hover:bg-stone-800",
  surface: "group-hover:bg-paper",
  primary: "group-hover:bg-[#3253ee]",
};

const BASE: Record<Variant, string> = {
  solid: "bg-stone-950",
  surface: "bg-rule-strong",
  primary: "bg-[#2238b8]",
};

const HIGHLIGHT: Record<Variant, string> = {
  solid: "shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
  surface: "shadow-[inset_0_1.5px_0_rgba(255,255,255,0.95),inset_0_-1px_0_rgba(28,25,23,0.06)]",
  primary: "shadow-[inset_0_1px_0_rgba(255,255,255,0.28),inset_0_-1px_0_rgba(18,28,90,0.18)]",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-[14px] gap-2",
};

export type PressDepthProps = {
  /** Navigates when set; otherwise renders a button that calls onClick. */
  href?: string;
  children: React.ReactNode;
  variant?: Variant;
  size?: Size;
  depth?: number;
  tilt?: number;
  className?: string;
  /** Classes for the moving face (e.g. w-full). */
  faceClassName?: string;
  onClick?: React.MouseEventHandler<HTMLElement>;
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-keyshortcuts"?: string;
  target?: string;
  rel?: string;
};

export function PressDepth({
  href,
  children,
  variant = "surface",
  size = "md",
  depth = 4,
  tilt = 7,
  className,
  faceClassName,
  onClick,
  type = "button",
  disabled = false,
  title,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-keyshortcuts": ariaKeyShortcuts,
  target,
  rel,
}: PressDepthProps) {
  const reduced = usePrefersReducedMotion();
  const { pressed, origin, ref, bind } = usePressDepth({ disabled });
  const lean = pressed && origin && !reduced ? origin : null;
  const Root = href ? "a" : "button";
  const rootProps = href ? { href, target, rel } : { type, disabled };

  return (
    <Root
      ref={ref}
      {...rootProps}
      title={title}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-keyshortcuts={ariaKeyShortcuts}
      data-pressed={pressed ? "" : undefined}
      onClick={onClick}
      style={{ paddingBottom: depth, touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
      className={cn(
        "group relative inline-flex w-fit shrink-0 select-none rounded-[10px] align-middle outline-none disabled:cursor-not-allowed disabled:opacity-55",
        className,
      )}
      {...bind}
    >
      <span aria-hidden style={{ top: depth }} className={cn("absolute inset-x-0 bottom-0 rounded-[10px]", BASE[variant])} />
      <m.span
        initial={false}
        animate={{
          y: pressed ? depth : 0,
          rotateX: lean ? -lean.y * tilt : 0,
          rotateY: lean ? lean.x * tilt : 0,
        }}
        transition={reduced ? { duration: 0 } : CELL}
        style={{ transformPerspective: 340 }}
        className={cn(
          "relative inline-flex items-center justify-center whitespace-nowrap rounded-[10px] border font-medium tracking-[0.01em] transition-colors duration-150",
          "group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-paper",
          !disabled && HOVER[variant],
          FACE[variant],
          SIZE[size],
          faceClassName,
        )}
      >
        <m.span
          aria-hidden
          initial={false}
          animate={{ opacity: pressed ? 0 : 1 }}
          transition={reduced ? { duration: 0 } : CELL}
          className={cn("pointer-events-none absolute inset-0 rounded-[10px]", HIGHLIGHT[variant])}
        />
        {children}
      </m.span>
    </Root>
  );
}

export default PressDepth;
