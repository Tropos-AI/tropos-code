/** Show More — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/show-more). Adapted for Tropos Code: lazy `m`, shared springs/reduced-motion hook, palette tokens, Icon chevron, latest-callback ref set in an effect. */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { m } from "motion/react";

import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

/** Height disclosure — a touch quicker than the shared DISCLOSE panel spring. */
const OPEN = { type: "spring", stiffness: 190, damping: 30, mass: 1 } as const;

const SMALL = { type: "spring", stiffness: 700, damping: 46, mass: 0.5 } as const;

type Metrics = { line: number; full: number };

export type UseShowMoreOptions = {
  lines?: number;
  maxHeight?: number;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

export type UseShowMoreResult = {
  contentRef: RefObject<HTMLDivElement | null>;
  expanded: boolean;
  open: boolean;
  toggle: () => void;
  setExpanded: (next: boolean) => void;
  height: number | null;
  collapsedHeight: number | null;
  fullHeight: number | null;
  expandable: boolean;
  capped: boolean;
  scrollable: boolean;
};

export function useShowMore({
  lines = 3,
  maxHeight = 320,
  defaultExpanded = false,
  expanded: expandedProp,
  onExpandedChange,
}: UseShowMoreOptions = {}): UseShowMoreResult {
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const expanded = expandedProp ?? uncontrolled;

  const notify = useRef(onExpandedChange);
  useEffect(() => {
    notify.current = onExpandedChange;
  });

  const setExpanded = useCallback(
    (next: boolean) => {
      if (expandedProp === undefined) setUncontrolled(next);
      notify.current?.(next);
    },
    [expandedProp],
  );

  const toggle = useCallback(() => setExpanded(!expanded), [setExpanded, expanded]);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const read = () => {
      const styles = getComputedStyle(el);
      const parsed = Number.parseFloat(styles.lineHeight);
      const line = Number.isFinite(parsed) ? parsed : Number.parseFloat(styles.fontSize) * 1.5;
      const full = el.scrollHeight;
      setMetrics((prev) => (prev && prev.line === line && prev.full === full ? prev : { line, full }));
    };

    read();

    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const clamped = metrics ? metrics.line * lines : 0;
  const expandable = metrics ? metrics.full - clamped > 1 : true;
  const capped = metrics ? metrics.full > maxHeight : false;
  const collapsedHeight = metrics ? Math.min(clamped, metrics.full) : null;
  const fullHeight = metrics ? Math.min(metrics.full, maxHeight) : null;
  const open = expanded && expandable;

  return {
    contentRef,
    expanded,
    open,
    toggle,
    setExpanded,
    height: open ? fullHeight : collapsedHeight,
    collapsedHeight,
    fullHeight,
    expandable,
    capped,
    scrollable: open && capped,
  };
}

export type ShowMoreProps = UseShowMoreOptions & {
  children: ReactNode;
  moreLabel?: string;
  lessLabel?: string;
  /** Accessible name of the region once it scrolls. */
  label?: string;
  className?: string;
};

export function ShowMore({
  children,
  moreLabel = "Show more",
  lessLabel = "Show less",
  label = "Details",
  lines = 3,
  maxHeight = 320,
  defaultExpanded,
  expanded,
  onExpandedChange,
  className,
}: ShowMoreProps) {
  const reduced = usePrefersReducedMotion();
  const regionId = useId();
  const regionRef = useRef<HTMLDivElement>(null);

  const { contentRef, open, toggle, height, expandable, capped, scrollable } = useShowMore({
    lines,
    maxHeight,
    defaultExpanded,
    expanded,
    onExpandedChange,
  });

  const press = () => {
    if (open) regionRef.current?.scrollTo({ top: 0 });
    toggle();
  };

  const veiled = expandable && (!open || scrollable);

  return (
    <div className={cn("text-[13.5px] leading-relaxed text-ink-2", className)}>
      <div className="relative">
        <m.div
          ref={regionRef}
          id={regionId}
          role={scrollable ? "region" : undefined}
          aria-label={scrollable ? label : undefined}
          tabIndex={scrollable ? 0 : undefined}
          initial={false}
          animate={height === null ? {} : { height }}
          transition={reduced ? INSTANT : OPEN}
          style={{
            maxHeight: height === null ? `${lines}lh` : undefined,
            overflowY: scrollable ? "auto" : "hidden",
            scrollbarGutter: capped ? "stable" : undefined,
          }}
          className="overflow-hidden overscroll-contain rounded-[6px] outline-none focus-visible:bg-accent/[0.06] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
        >
          <div ref={contentRef}>{children}</div>
        </m.div>
        <m.div
          aria-hidden
          initial={false}
          animate={{ opacity: veiled ? 1 : 0 }}
          transition={reduced ? INSTANT : SMALL}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-linear-to-t from-surface to-surface/0"
        />
      </div>
      <div className="mt-2 flex h-8 items-center">
        <button
          type="button"
          onClick={press}
          aria-expanded={open}
          aria-controls={regionId}
          className={cn(
            "inline-flex h-8 select-none items-center gap-2 rounded-[9px] border border-rule bg-surface px-2.5 text-[12.5px] font-medium text-ink-2 outline-none transition-[border-color,box-shadow] duration-150 hover:border-rule-strong focus-visible:border-accent focus-visible:shadow-focus",
            !expandable && "pointer-events-none invisible",
          )}
        >
          <span className="grid text-left">
            <m.span
              aria-hidden={open}
              className="col-start-1 row-start-1"
              initial={false}
              animate={{ opacity: open ? 0 : 1 }}
              transition={reduced ? INSTANT : SMALL}
            >
              {moreLabel}
            </m.span>
            <m.span
              aria-hidden={!open}
              className="col-start-1 row-start-1"
              initial={false}
              animate={{ opacity: open ? 1 : 0 }}
              transition={reduced ? INSTANT : SMALL}
            >
              {lessLabel}
            </m.span>
          </span>
          <m.span
            aria-hidden
            className="inline-flex text-ink-3"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduced ? INSTANT : SMALL}
          >
            <Icon name="chevron-down" size="sm" />
          </m.span>
        </button>
      </div>
    </div>
  );
}

export default ShowMore;
