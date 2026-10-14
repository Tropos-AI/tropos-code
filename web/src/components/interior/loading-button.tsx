/**
 * Loading Button — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/loading-button).
 *
 * The label morphs through pending, success and error without layout shift.
 * Adapted for Tropos Labs (then for Tropos Code: Vite, shared springs in lib/springs, Cojeev icons): the async state lives in `useAsyncAction` so a form
 * can drive it (Enter submits), the button is a submit button with a solid
 * ink face, and motion is lazy-loaded.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { m } from "motion/react";

import { CELL, CROSSFADE, INSTANT } from "@/lib/springs";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type AsyncActionStatus = "idle" | "pending" | "success" | "error";

export function useAsyncAction({
  action,
  onError,
}: {
  action: () => Promise<unknown>;
  onError?: (error: unknown) => void;
}) {
  const [status, setStatus] = useState<AsyncActionStatus>("idle");
  const phase = useRef<AsyncActionStatus>("idle");
  const runId = useRef(0);
  const alive = useRef(true);
  const act = useRef(action);
  const fail = useRef(onError);

  useEffect(() => {
    act.current = action;
    fail.current = onError;
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(() => {
    if (phase.current === "pending") return;
    const id = ++runId.current;
    phase.current = "pending";
    setStatus("pending");

    const settle = (next: "success" | "error") => {
      if (!alive.current || id !== runId.current) return;
      phase.current = next;
      setStatus(next);
    };

    Promise.resolve()
      .then(() => act.current())
      .then(
        () => settle("success"),
        (error: unknown) => {
          fail.current?.(error);
          settle("error");
        },
      );
  }, []);

  const reset = useCallback(() => {
    runId.current += 1;
    phase.current = "idle";
    setStatus("idle");
  }, []);

  return { status, run, reset, pending: status === "pending" };
}

function Spinner({ still }: { still: boolean }) {
  return (
    <m.span
      aria-hidden="true"
      className="grid shrink-0 place-items-center"
      animate={still ? undefined : { rotate: 360 }}
      transition={still ? undefined : { duration: 0.85, repeat: Infinity, ease: "linear" }}
    >
      <Icon name="loader-circle" size="sm" />
    </m.span>
  );
}

export type LoadingButtonProps = {
  status: AsyncActionStatus;
  children: string;
  pendingLabel?: string;
  errorLabel?: string;
  className?: string;
};

export function LoadingButton({
  status,
  children,
  pendingLabel = children,
  errorLabel = "Try again",
  className,
}: LoadingButtonProps) {
  const reduced = usePrefersReducedMotion();
  const pending = status === "pending";
  const fade = reduced ? INSTANT : CROSSFADE;
  const shown = status === "success" ? "idle" : status;

  const faces = [
    { key: "idle", text: children, icon: null },
    { key: "pending", text: pendingLabel, icon: <Spinner still={reduced || !pending} /> },
    { key: "error", text: errorLabel, icon: null },
  ];

  return (
    <m.button
      type="submit"
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      whileTap={pending || reduced ? undefined : { y: 1 }}
      transition={CELL}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      style={{ borderRadius: 11, touchAction: "manipulation" }}
      className={cn(
        "relative inline-flex h-12 w-full select-none items-center justify-center rounded-[11px] border border-stone-900 bg-stone-900 px-5 text-[15px] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_1px_2px_rgba(28,25,23,0.2)] outline-none transition-colors duration-150 hover:bg-stone-800 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
        className,
      )}
    >
      <span className="sr-only">{faces.find((face) => face.key === shown)?.text}</span>
      <span aria-hidden className="relative grid place-items-center">
        {faces.map((face) => (
          <m.span
            key={face.key}
            initial={false}
            animate={
              face.key === shown
                ? { opacity: 1, y: 0, filter: "blur(0px)" }
                : { opacity: 0, y: 3, filter: "blur(3px)" }
            }
            transition={fade}
            className="col-start-1 row-start-1 flex items-center justify-center gap-2 whitespace-nowrap"
          >
            {face.icon}
            {face.text}
          </m.span>
        ))}
      </span>
    </m.button>
  );
}

export default LoadingButton;
