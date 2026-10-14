/** StickyHeader — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/sticky-header). Adapted for Tropos Code: lazy `m` components, app reduced-motion hook, palette tokens and card shadow, no dark variants. */
import { useRef, useState, type ReactNode, type RefObject } from "react";
import {
  m,
  useMotionValueEvent,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

const SMOOTH = { stiffness: 240, damping: 44, mass: 0.6 } as const;

export type UseCondenseOptions = {
  /** Scroll distance (px) over which the header condenses. */
  range?: number;
};

export type UseCondenseResult<T extends HTMLElement> = {
  ref: RefObject<T | null>;
  progress: MotionValue<number>;
  condensed: boolean;
};

/** 0→1 progress of a scroll container over `range` px, plus a settled `condensed` flag. */
export function useCondense<T extends HTMLElement = HTMLDivElement>({
  range = 48,
}: UseCondenseOptions = {}): UseCondenseResult<T> {
  const ref = useRef<T | null>(null);
  const { scrollY } = useScroll({ container: ref });

  const progress = useTransform(scrollY, [0, Math.max(1, range)], [0, 1], { clamp: true });

  const [condensed, setCondensed] = useState(false);
  useMotionValueEvent(progress, "change", (p) => {
    const done = p >= 1;
    setCondensed((prev) => (prev === done ? prev : done));
  });

  return { ref, progress, condensed };
}

export type StickyHeaderProps = {
  title: string;
  children: ReactNode;
  subtitle?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  expandedHeight?: number;
  compactHeight?: number;
  maxHeight?: number;
  className?: string;
};

export function StickyHeader({
  title,
  children,
  subtitle,
  leading,
  actions,
  expandedHeight = 68,
  compactHeight = 48,
  maxHeight = 320,
  className,
}: StickyHeaderProps) {
  const tall = Math.max(expandedHeight, compactHeight);
  const short = Math.min(expandedHeight, compactHeight);
  const travel = Math.max(1, tall - short);

  const { ref, progress: tracked, condensed } = useCondense<HTMLDivElement>({ range: Math.max(64, travel * 3) });
  const reduced = usePrefersReducedMotion();
  const sprung = useSpring(tracked, SMOOTH);
  const progress = reduced ? tracked : sprung;

  const plate = useTransform(progress, (p) => (tall - travel * p) / tall);
  const edge = useTransform(progress, (p) => tall - travel * p);
  const lifted = useTransform(progress, [0, 0.12], [0, 1], { clamp: true });

  const bigY = useTransform(progress, (p) => -travel * p);
  const bigOpacity = useTransform(progress, [0, 0.45], [1, 0], { clamp: true });
  const bigScale = useTransform(progress, (p) => 1 - 0.05 * p);

  const smallOpacity = useTransform(progress, [0.55, 0.9], [0, 1], { clamp: true });
  const smallY = useTransform(smallOpacity, (o) => (1 - o) * 6);

  return (
    <div className={cn("relative overflow-hidden rounded-[14px] border border-rule bg-surface shadow-card", className)}>
      <div
        ref={ref}
        tabIndex={0}
        role="region"
        aria-label={title}
        style={{ maxHeight, scrollPaddingTop: short + 10 }}
        className="overflow-y-auto overscroll-y-contain outline-none [scrollbar-gutter:stable] focus-visible:bg-accent/[0.06] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
      >
        <div aria-hidden style={{ height: tall }} />
        {children}

        <div
          aria-hidden
          className="pointer-events-none sticky bottom-0 -mt-6 h-6 bg-gradient-to-t from-surface to-transparent"
        />
      </div>
      <header
        data-condensed={condensed ? "true" : "false"}
        style={{ height: tall }}
        className="pointer-events-none absolute inset-x-0 top-0"
      >
        <m.div
          aria-hidden
          style={{ height: tall, scaleY: plate }}
          className="absolute inset-x-0 top-0 origin-top bg-surface"
        />
        <m.div
          aria-hidden
          style={{ y: edge, opacity: lifted }}
          className="absolute inset-x-0 top-0 h-px shadow-[0_6px_16px_-10px_rgba(28,25,23,0.4)]"
        />
        <m.div
          aria-hidden
          style={{ y: edge, opacity: lifted }}
          className="absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-surface to-transparent"
        />
        <m.div aria-hidden style={{ y: edge, opacity: lifted }} className="absolute inset-x-0 top-0 h-px bg-rule" />
        <div className="absolute inset-x-0 top-0 flex items-start gap-2.5 px-4 pt-3">
          {leading ? <div className="pointer-events-auto flex h-6 shrink-0 items-center">{leading}</div> : null}

          <div className="relative min-w-0 flex-1">
            <m.div style={{ y: bigY, opacity: bigOpacity, scale: bigScale, transformOrigin: "left top" }}>
              <h2 className="truncate text-[20px] font-medium leading-[1.2] tracking-[-0.03em] text-ink">{title}</h2>
              {subtitle ? <p className="mt-0.5 truncate text-[11.5px] leading-[1.35] text-ink-3">{subtitle}</p> : null}
            </m.div>
            <m.span
              aria-hidden
              style={{ opacity: smallOpacity, y: smallY }}
              className="absolute inset-x-0 top-[3px] truncate text-[13px] font-medium leading-[1.4] text-ink-2"
            >
              {title}
            </m.span>
          </div>

          {actions ? (
            <div className="pointer-events-auto flex h-6 shrink-0 items-center gap-1.5">{actions}</div>
          ) : null}
        </div>
      </header>
    </div>
  );
}

export default StickyHeader;
