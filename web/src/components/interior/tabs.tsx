/**
 * Tabs — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/tabs).
 *
 * Adapted for Tropos Labs (then for Tropos Code: Vite, shared springs in lib/springs, Cojeev icons): a browser-tab treatment (the selected tab's white
 * plateau grows curved feet and merges into the panel), panels that crossfade
 * in place, a scrollable strip on narrow screens. The sliding plateau and the
 * keyboard model are the library's.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

const INDICATOR = { type: "spring", stiffness: 620, damping: 42, mass: 0.35 } as const;
const PANEL = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type TabItem = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type UseTabsOptions = {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

export function useTabs({ items, value: controlled, defaultValue, onValueChange }: UseTabsOptions) {
  const base = useId();
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const [direction, setDirection] = useState(1);

  const [internal, setInternal] = useState(
    () => defaultValue ?? items.find((i) => !i.disabled)?.value ?? items[0]?.value ?? "",
  );

  const value = controlled ?? internal;

  const emit = useRef(onValueChange);
  useEffect(() => {
    emit.current = onValueChange;
  });

  const select = useCallback(
    (next: string) => {
      if (next === value) return;
      const from = items.findIndex((i) => i.value === value);
      const to = items.findIndex((i) => i.value === next);
      setDirection(to < from ? -1 : 1);
      if (controlled === undefined) setInternal(next);
      emit.current?.(next);
    },
    [controlled, items, value],
  );

  const focusAt = useCallback(
    (i: number) => {
      const item = items[i];
      if (!item) return;
      nodes.current.get(item.value)?.focus();
    },
    [items],
  );

  const nextEnabled = useCallback(
    (from: number, dir: number) => {
      const n = items.length;
      let i = from < 0 ? 0 : from;
      for (let k = 0; k < n; k += 1) {
        i = (i + dir + n) % n;
        if (!items[i].disabled) return i;
      }
      return from;
    },
    [items],
  );

  const endStop = useCallback(
    (dir: number) => {
      const n = items.length;
      if (dir > 0) {
        for (let i = 0; i < n; i += 1) if (!items[i].disabled) return i;
      } else {
        for (let i = n - 1; i >= 0; i -= 1) if (!items[i].disabled) return i;
      }
      return 0;
    },
    [items],
  );

  const getTabProps = useCallback(
    (item: TabItem, index: number) => ({
      id: `${base}-tab-${item.value}`,
      role: "tab" as const,
      type: "button" as const,
      "aria-selected": item.value === value,
      "aria-controls": `${base}-panel-${item.value}`,
      "aria-disabled": item.disabled ? (true as const) : undefined,
      tabIndex: item.value === value ? 0 : -1,
      onClick: () => {
        if (!item.disabled) select(item.value);
      },
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const to = nextEnabled(index, e.key === "ArrowRight" ? 1 : -1);
          focusAt(to);
          select(items[to].value);
          return;
        }
        if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          const to = endStop(e.key === "Home" ? 1 : -1);
          focusAt(to);
          select(items[to].value);
        }
      },
    }),
    [base, endStop, focusAt, items, nextEnabled, select, value],
  );

  const registerTab = useCallback((item: TabItem, node: HTMLButtonElement | null) => {
    if (node) nodes.current.set(item.value, node);
    else nodes.current.delete(item.value);
  }, []);

  const getPanelProps = useCallback(
    (panelValue: string) => ({
      id: `${base}-panel-${panelValue}`,
      role: "tabpanel" as const,
      "aria-labelledby": `${base}-tab-${panelValue}`,
      tabIndex: 0,
    }),
    [base],
  );

  return { value, select, direction, getTabProps, getPanelProps, registerTab };
}

export type TabsProps = {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  renderPanel: (value: string) => ReactNode;
  label?: string;
  panelClassName?: string;
  className?: string;
};

export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  renderPanel,
  label = "Tabs",
  panelClassName,
  className,
}: TabsProps) {
  const tabs = useTabs({ items, value, defaultValue, onValueChange });
  const reduced = usePrefersReducedMotion();

  const rowRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [plateau, setPlateau] = useState({ x: 0, width: 0, ready: false });

  const selectedIndex = items.findIndex((item) => item.value === tabs.value);

  useIsoLayoutEffect(() => {
    const node = tabRefs.current[selectedIndex];
    if (!node) return;

    const read = () => {
      setPlateau((prev) =>
        prev.x === node.offsetLeft && prev.width === node.offsetWidth && prev.ready
          ? prev
          : { x: node.offsetLeft, width: node.offsetWidth, ready: true },
      );
    };

    read();
    const row = rowRef.current;
    if (!row) return;
    // Keep the selected tab visible inside a scrolled (narrow) tab row
    // without ever scrolling the page itself.
    const left = node.offsetLeft - 6;
    const right = node.offsetLeft + node.offsetWidth + 6;
    if (left < row.scrollLeft) row.scrollLeft = left;
    else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth;
    const observer = new ResizeObserver(read);
    observer.observe(row);
    return () => observer.disconnect();
  }, [selectedIndex, items]);

  return (
    <div className={cn("w-full overflow-hidden rounded-[16px] border border-rule bg-surface shadow-card", className)}>
      {/* Chrome-style strip: the selected tab is a white shape with curved
          feet that flows straight into the panel below it. */}
      <div
        role="tablist"
        aria-orientation="horizontal"
        ref={rowRef}
        aria-label={label}
        className="relative flex w-full overflow-x-auto bg-stone-200/70 px-3 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <m.span
          layout
          aria-hidden
          style={{ left: plateau.x, width: plateau.width }}
          transition={reduced ? { duration: 0 } : INDICATOR}
          className={cn(
            "absolute bottom-0 top-2 rounded-t-[12px] bg-surface",
            !plateau.ready && "invisible",
            "before:absolute before:bottom-0 before:-left-3 before:size-3 before:bg-[radial-gradient(circle_at_0_0,transparent_12px,white_12.5px)] before:content-['']",
            "after:absolute after:bottom-0 after:-right-3 after:size-3 after:bg-[radial-gradient(circle_at_100%_0,transparent_12px,white_12.5px)] after:content-['']",
          )}
        />

        {items.map((item, index) => {
          const selected = item.value === tabs.value;
          const nextSelected = items[index + 1]?.value === tabs.value;
          const showDivider = !selected && !nextSelected && index < items.length - 1;
          return (
            <button
              key={item.value}
              {...tabs.getTabProps(item, index)}
              ref={(node) => {
                tabRefs.current[index] = node;
                tabs.registerTab(item, node);
              }}
              className={cn(
                "group relative flex h-11 shrink-0 items-center px-1.5 text-[14px] outline-none",
                item.disabled ? "cursor-default text-ink-3" : selected ? "text-ink" : "text-ink-2",
              )}
            >
              <span
                className={cn(
                  "relative flex h-8 items-center gap-2.5 rounded-[9px] px-3 transition-colors duration-150",
                  !selected && "group-hover:bg-surface/60",
                  "group-focus-visible:shadow-[inset_0_0_0_1.5px_var(--accent)]",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-[3px] transition-colors duration-150",
                    selected ? "bg-accent" : "bg-stone-400",
                  )}
                />
                <span className="grid">
                  <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-nowrap font-medium">
                    {item.label}
                  </span>
                  <span className={cn("col-start-1 row-start-1 whitespace-nowrap", selected && "font-medium")}>
                    {item.label}
                  </span>
                </span>
              </span>
              <span
                aria-hidden
                className={cn(
                  "absolute right-0 top-1/2 h-4 w-px -translate-y-1/2 bg-stone-300 transition-opacity duration-150",
                  showDivider ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          );
        })}
      </div>

      {/* Panels crossfade in place, so old and new content blend. */}
      <div className="grid">
        <AnimatePresence initial={false}>
          <m.div
            key={tabs.value}
            {...tabs.getPanelProps(tabs.value)}
            initial={reduced ? false : { opacity: 0, filter: "blur(6px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, filter: "blur(6px)" }}
            transition={reduced ? { duration: 0 } : PANEL}
            className={cn(
              "col-start-1 row-start-1 outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--accent)]",
              panelClassName,
            )}
          >
            {renderPanel(tabs.value)}
          </m.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export default Tabs;
