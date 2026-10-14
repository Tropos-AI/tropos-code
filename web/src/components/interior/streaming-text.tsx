/**
 * Streaming Text — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/streaming-text).
 *
 * Adapted for Tropos Labs (then for Tropos Code: Vite, shared springs in lib/springs, Cojeev icons): a `delayMs` before streaming starts (the caret
 * blinks while it waits), streaming can be gated on `autoStart` (e.g. when in
 * view), typography comes from the caller, and the caret is the Interior
 * periwinkle. Layout is reserved by an invisible copy, so nothing reflows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { m } from "motion/react";

import { CROSSFADE } from "@/lib/springs";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

const CHARS_PER_TOKEN = 4;
const MAX_FRAME_DELTA = 64;

export type StreamingTextStatus = "idle" | "streaming" | "paused" | "done";

export type UseStreamingTextOptions = {
  text: string;
  tokensPerSecond?: number;
  autoStart?: boolean;
  delayMs?: number;
  onDone?: () => void;
};

export function useStreamingText({
  text,
  tokensPerSecond = 18,
  autoStart = true,
  delayMs = 0,
  onDone,
}: UseStreamingTextOptions) {
  const reduced = usePrefersReducedMotion();
  const total = text.length;

  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<StreamingTextStatus>("idle");

  const cursor = useRef(0);
  const finished = useRef(onDone);

  useEffect(() => {
    finished.current = onDone;
  }, [onDone]);

  const start = useCallback(() => {
    setStatus((s) => (s === "done" ? s : "streaming"));
  }, []);

  const skip = useCallback(() => {
    cursor.current = total;
    setIndex(total);
    setStatus("done");
  }, [total]);

  const reset = useCallback(() => {
    cursor.current = 0;
    setIndex(0);
    setStatus("idle");
  }, []);

  // (Re)start whenever the text changes or streaming is allowed to begin.
  useEffect(() => {
    cursor.current = 0;
    if (!autoStart) return;
    const id = window.setTimeout(() => {
      setIndex(0);
      setStatus("streaming");
    }, delayMs);
    return () => window.clearTimeout(id);
  }, [text, autoStart, delayMs]);

  useEffect(() => {
    if (status !== "streaming") return;
    if (reduced || cursor.current >= total) {
      cursor.current = total;
      const id = requestAnimationFrame(() => {
        setIndex(total);
        setStatus("done");
      });
      return () => cancelAnimationFrame(id);
    }

    const interval = 1000 / Math.max(1, tokensPerSecond * CHARS_PER_TOKEN);
    let frame = 0;
    let last = performance.now();
    let carry = 0;

    const tick = (now: number) => {
      carry += Math.min(now - last, MAX_FRAME_DELTA);
      last = now;

      if (carry >= interval) {
        const advance = Math.floor(carry / interval);
        carry -= advance * interval;
        const next = Math.min(total, cursor.current + advance);
        cursor.current = next;
        setIndex(next);
        if (next >= total) {
          setStatus("done");
          return;
        }
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [status, total, tokensPerSecond, reduced]);

  useEffect(() => {
    if (status === "done") finished.current?.();
  }, [status]);

  // Reduced motion: show the whole response at once.
  useEffect(() => {
    if (!reduced) return;
    cursor.current = total;
    const id = requestAnimationFrame(() => {
      setIndex(total);
      setStatus("done");
    });
    return () => cancelAnimationFrame(id);
  }, [reduced, total]);

  const visible = useMemo(() => text.slice(0, index), [text, index]);

  return { index, total, status, visible, start, skip, reset };
}

export type StreamingTextProps = {
  text: string;
  tokensPerSecond?: number;
  autoStart?: boolean;
  delayMs?: number;
  showSkip?: boolean;
  label?: string;
  onDone?: () => void;
  className?: string;
  /** Typography for the streamed paragraph. */
  textClassName?: string;
};

export function StreamingText({
  text,
  tokensPerSecond = 18,
  autoStart = true,
  delayMs = 0,
  showSkip = true,
  label = "Streamed response",
  onDone,
  className,
  textClassName,
}: StreamingTextProps) {
  const { visible, status, skip, start, reset } = useStreamingText({
    text,
    tokensPerSecond,
    autoStart,
    delayMs,
    onDone,
  });
  const reduced = usePrefersReducedMotion();

  const done = status === "done";
  const blink = !reduced && (status === "idle" || status === "paused");

  const caret = (
    <span aria-hidden className="relative inline-block h-[1.05em] w-0 align-[-0.16em]">
      <m.span
        className="absolute inset-y-0 left-[2px] block w-[0.09em] min-w-[2px] rounded-full bg-accent"
        initial={false}
        animate={blink ? { opacity: [1, 1, 0, 0] } : { opacity: done ? 0 : 1 }}
        transition={blink ? { duration: 1.06, times: [0, 0.45, 0.5, 0.95], repeat: Infinity, ease: "linear" } : CROSSFADE}
      />
    </span>
  );

  return (
    <div role="group" aria-label={label} aria-busy={status === "streaming"} className={className}>
      {/* An invisible copy reserves the final layout; the stream is drawn
          over it. Assistive tech reads the full text once, up front. */}
      <p className={cn("relative whitespace-pre-line", textClassName)}>
        <span className="sr-only">{text}</span>
        <span aria-hidden className="invisible">
          {text}
        </span>
        <span aria-hidden className="absolute inset-0 whitespace-pre-line">
          {visible}
          {caret}
        </span>
      </p>

      {showSkip ? (
        <div className="mt-6 flex">
          <button
            type="button"
            onClick={
              done
                ? () => {
                    reset();
                    start();
                  }
                : skip
            }
            aria-label={done ? `Replay ${label.toLowerCase()}` : "Skip to the full text"}
            className="inline-grid h-8 place-items-center rounded-[7px] border border-rule bg-surface px-3 text-[12.5px] font-medium text-ink-3 shadow-[inset_0_1.5px_0_rgba(255,255,255,0.95),0_1px_2px_rgba(28,25,23,0.06)] outline-none transition-colors duration-150 hover:text-ink focus-visible:border-accent"
          >
            <m.span
              aria-hidden
              className="col-start-1 row-start-1"
              initial={false}
              animate={{ opacity: done ? 0 : 1 }}
              transition={reduced ? { duration: 0 } : CROSSFADE}
            >
              Skip
            </m.span>
            <m.span
              aria-hidden
              className="col-start-1 row-start-1"
              initial={false}
              animate={{ opacity: done ? 1 : 0 }}
              transition={reduced ? { duration: 0 } : CROSSFADE}
            >
              Replay
            </m.span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default StreamingText;
