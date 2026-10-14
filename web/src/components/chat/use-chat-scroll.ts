// web/src/components/chat/use-chat-scroll.ts — keeps the transcript pinned to the newest output while the reader is at
// the bottom, and counts what arrives while they have scrolled up (for Interior's New Items Pill).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/** Pixels from the bottom that still count as "at the newest". */
const THRESHOLD = 56;

export interface ChatScroll {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Items (or growth of the live item) that arrived while scrolled up. */
  unread: number;
  /** Smooth-scrolls to the newest output. */
  jump: () => void;
  /** Re-pins to the bottom at once (after the user sends). */
  pin: () => void;
}

/**
 * `itemCount` counts transcript rows; `resetKey` changes on a new session (scroll to the end, forget unread); `busy`
 * tells growth of a streaming reply (worth a "new" pill) from the reader expanding something themselves.
 */
export function useChatScroll(itemCount: number, resetKey: number, busy: boolean): ChatScroll {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  /** A smooth jump is under way: its intermediate scroll events must not unpin. */
  const jumping = useRef(false);
  const busyRef = useRef(busy);
  const lastCount = useRef(itemCount);
  /** The last scrollTop seen, to tell the reader scrolling up from content growing under a pinned view. */
  const lastTop = useRef(0);
  const [unread, setUnread] = useState(0);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Scroll events arrive a frame late: by then a streaming reply may have grown again, so "far from the bottom" alone
    // does not mean the reader left. Only scrolling up unpins; reaching the bottom pins again.
    const onScroll = () => {
      const top = el.scrollTop;
      const near = el.scrollHeight - top - el.clientHeight <= THRESHOLD;
      const wentUp = top < lastTop.current - 1;
      lastTop.current = top;
      if (jumping.current) {
        if (!near) return;
        jumping.current = false;
      }
      if (near) {
        if (!pinned.current) {
          pinned.current = true;
          setUnread(0);
        }
      } else if (wentUp && pinned.current) {
        pinned.current = false;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Streaming text, expanding cards and a growing composer all change sizes without adding rows.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    let lastHeight = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = content.offsetHeight;
      const grew = height > lastHeight;
      lastHeight = height;
      if (pinned.current || jumping.current) toBottom();
      else if (grew && busyRef.current) setUnread((n) => Math.max(n, 1));
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [toBottom]);

  useLayoutEffect(() => {
    const added = itemCount - lastCount.current;
    lastCount.current = itemCount;
    if (added <= 0) return;
    if (pinned.current) toBottom();
    else setUnread((n) => n + added);
  }, [itemCount, toBottom]);

  useLayoutEffect(() => {
    pinned.current = true;
    jumping.current = false;
    setUnread(0);
    toBottom();
  }, [resetKey, toBottom]);

  const pin = useCallback(() => {
    pinned.current = true;
    jumping.current = false;
    setUnread(0);
    toBottom();
  }, [toBottom]);

  const jump = useCallback(() => {
    const el = scrollRef.current;
    pinned.current = true;
    setUnread(0);
    if (!el) return;
    if (reduced) {
      toBottom();
      return;
    }
    jumping.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [reduced, toBottom]);

  return { scrollRef, contentRef, unread, jump, pin };
}
