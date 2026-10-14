/** New Items Pill — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/new-items-pill). Adapted for Tropos Code: lazy `m`, shared EASE/INSTANT and reduced-motion hook, palette tokens, Icon arrow, latest-value ref synced in an effect. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { AnimatePresence, m } from "motion/react";

import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { EASE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

const ARRIVE = { type: "spring", stiffness: 540, damping: 34, mass: 0.5 } as const;

export type NewItemsAnchor = "top" | "bottom";

export type UseNewItemsOptions = {
  itemCount: number;
  /** Where the newest items land: "top" for feeds, "bottom" for chats. */
  anchor?: NewItemsAnchor;
  /** Pixels from the anchor edge that still count as "at the newest". */
  threshold?: number;
};

export type UseNewItemsResult<T extends HTMLElement> = {
  scrollProps: {
    ref: RefObject<T | null>;
    tabIndex: number;
    style: CSSProperties;
  };
  unread: number;
  pinned: boolean;
  /** Scrolls to the newest items and returns how many were unread. */
  jump: () => number;
};

export function useNewItems<T extends HTMLElement = HTMLDivElement>({
  itemCount,
  anchor = "top",
  threshold = 24,
}: UseNewItemsOptions): UseNewItemsResult<T> {
  const ref = useRef<T | null>(null);
  const pinnedRef = useRef(true);
  const prevCount = useRef(itemCount);
  const bottomGap = useRef(0);

  const [unread, setUnread] = useState(0);
  const [pinned, setPinned] = useState(true);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const read = () =>
      anchor === "bottom" ? el.scrollHeight - el.scrollTop - el.clientHeight <= threshold : el.scrollTop <= threshold;

    const onScroll = () => {
      bottomGap.current = el.scrollHeight - el.scrollTop;
      const next = read();
      if (next === pinnedRef.current) return;
      pinnedRef.current = next;
      setPinned(next);
      if (next) setUnread(0);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [anchor, threshold]);

  useLayoutEffect(() => {
    const el = ref.current;
    const added = itemCount - prevCount.current;
    prevCount.current = itemCount;
    if (!el || added <= 0) return;

    if (pinnedRef.current) {
      el.scrollTop = anchor === "bottom" ? el.scrollHeight : 0;
      bottomGap.current = el.scrollHeight - el.scrollTop;
      return;
    }

    // Keep what the reader is looking at still while new rows push in above it.
    if (anchor === "top") {
      const target = el.scrollHeight - bottomGap.current;
      if (target > el.scrollTop) el.scrollTop = target;
    }
    setUnread((n) => n + added);
  }, [itemCount, anchor]);

  const unreadRef = useRef(0);
  useEffect(() => {
    unreadRef.current = unread;
  });

  const jump = useCallback(() => {
    const el = ref.current;
    const caught = unreadRef.current;
    if (!el) return caught;
    pinnedRef.current = true;
    setPinned(true);
    setUnread(0);

    el.focus({ preventScroll: true });
    el.scrollTo({
      top: anchor === "bottom" ? el.scrollHeight : 0,
      behavior: reduced ? "auto" : "smooth",
    });
    return caught;
  }, [anchor, reduced]);

  return {
    scrollProps: { ref, tabIndex: 0, style: { overflowAnchor: "none" } },
    unread,
    pinned,
    jump,
  };
}

export type NewItemsPillProps = {
  count: number;
  onJump: () => void;
  anchor?: NewItemsAnchor;
  label?: (count: number) => string;
  max?: number;
  className?: string;
};

const defaultLabel = (n: number) => `${n} new ${n === 1 ? "item" : "items"}`;

export function NewItemsPill({ count, onJump, anchor = "top", label = defaultLabel, max = 99, className }: NewItemsPillProps) {
  const reduced = usePrefersReducedMotion();
  const [announced, setAnnounced] = useState(0);

  // Announce once the count settles, not on every arrival.
  useEffect(() => {
    if (count === 0) {
      setAnnounced(0);
      return;
    }
    const t = setTimeout(() => setAnnounced(count), 700);
    return () => clearTimeout(t);
  }, [count]);

  const phrase = (n: number) => (n > max ? `${max}+ new items` : label(n));
  const text = phrase(count);
  const off = anchor === "bottom" ? 10 : -10;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 flex justify-center",
        anchor === "bottom" ? "bottom-2" : "top-2",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {count > 0 && (
          <m.button
            type="button"
            onClick={onJump}
            aria-label={text}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: off }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={
              reduced
                ? { opacity: 0, transition: INSTANT }
                : { opacity: 0, scale: 0.96, y: off * 0.5, transition: { duration: 0.16, ease: EASE } }
            }
            transition={reduced ? INSTANT : { ...ARRIVE, opacity: { duration: 0.16, ease: EASE } }}
            className="pointer-events-auto inline-flex h-8 select-none items-center gap-1.5 rounded-[9px] border border-rule bg-surface pl-2 pr-2.5 text-[12.5px] font-medium text-ink-2 shadow-card outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-accent focus-visible:shadow-focus"
          >
            <Icon name="arrow-up" size="sm" className={cn(anchor === "bottom" && "rotate-180")} />
            <span className="tabular-nums" aria-hidden="true">
              {text}
            </span>
          </m.button>
        )}
      </AnimatePresence>
      <span role="status" aria-live="polite" className="sr-only">
        {announced > 0 ? phrase(announced) : ""}
      </span>
    </div>
  );
}

export default NewItemsPill;
