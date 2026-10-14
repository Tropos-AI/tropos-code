/**
 * Copy Button — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/copy-button).
 * Idle → copied → error states with an icon crossfade and blurred label swap.
 * Adapted only for the shared springs, focus accent and hydration-safe
 * reduced-motion check.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { m } from "motion/react";

import { Icon, type IconName } from "@/components/ui/icon";
import { CELL, CROSSFADE, INSTANT } from "@/lib/springs";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

export type CopyStatus = "idle" | "copied" | "error";

function writeFallback(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  document.body.removeChild(area);
  if (selection && previous) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}

export function useCopyToClipboard({ timeout = 2000 }: { timeout?: number } = {}) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const [ticket, setTicket] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const copy = useCallback(async (text: string) => {
    if (!text) return false;
    let ok = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = writeFallback(text);
      }
    } catch {
      try {
        ok = writeFallback(text);
      } catch {
        ok = false;
      }
    }
    if (!mounted.current) return ok;
    setStatus(ok ? "copied" : "error");
    setTicket((t) => t + 1);
    return ok;
  }, []);

  useEffect(() => {
    if (ticket === 0 || status === "idle") return;
    const id = setTimeout(() => setStatus("idle"), timeout);
    return () => clearTimeout(id);
  }, [ticket, status, timeout]);

  return { copy, status };
}

export type CopyButtonProps = {
  value: string;
  label?: string;
  copiedLabel?: string;
  errorLabel?: string;
  className?: string;
};

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  errorLabel = "Failed",
  className,
}: CopyButtonProps) {
  const { copy, status } = useCopyToClipboard();
  const reduced = usePrefersReducedMotion();
  const fade = reduced ? INSTANT : CROSSFADE;

  const glyphs: Array<[CopyStatus, IconName]> = [
    ["idle", "copy"],
    ["copied", "check"],
    ["error", "x"],
  ];
  const labels: Array<[CopyStatus, string]> = [
    ["idle", label],
    ["copied", copiedLabel],
    ["error", errorLabel],
  ];

  return (
    <m.button
      type="button"
      aria-label={label}
      onClick={() => {
        void copy(value);
      }}
      whileTap={reduced ? undefined : { y: 1 }}
      transition={CELL}
      style={{ borderRadius: 10, touchAction: "manipulation" }}
      className={cn(
        "inline-flex h-11 select-none items-center gap-2.5 rounded-[10px] border border-rule bg-surface px-4 text-[14px] font-medium text-ink shadow-[inset_0_1.5px_0_rgba(255,255,255,0.95),inset_0_-1px_0_rgba(28,25,23,0.06),0_1px_2px_rgba(28,25,23,0.08)] outline-none transition-[border-color,box-shadow,background-color] duration-150 hover:bg-paper focus-visible:border-accent focus-visible:shadow-[0_1px_2px_rgba(28,25,23,0.08),0_10px_20px_-14px_rgba(69,104,255,0.6)]",
        className,
      )}
    >
      <span className="grid size-[15px] shrink-0 place-items-center" aria-hidden="true">
        {glyphs.map(([key, name]) => (
          <m.span
            key={key}
            className={cn("col-start-1 row-start-1 grid place-items-center", key === "copied" && "text-accent-ink")}
            initial={false}
            animate={{ opacity: status === key ? 1 : 0, scale: status === key ? 1 : 0.92 }}
            transition={fade}
          >
            <Icon name={name} size="sm" />
          </m.span>
        ))}
      </span>

      <span aria-hidden="true" className="relative grid">
        {labels.map(([key, text]) => (
          <m.span
            key={key}
            initial={false}
            animate={key === status ? { opacity: 1, y: 0, filter: "blur(0px)" } : { opacity: 0, y: 3, filter: "blur(3px)" }}
            transition={fade}
            className="col-start-1 row-start-1 whitespace-nowrap"
          >
            {text}
          </m.span>
        ))}
      </span>

      <span role="status" aria-live="polite" className="sr-only">
        {status === "copied" ? copiedLabel : status === "error" ? errorLabel : ""}
      </span>
    </m.button>
  );
}

export default CopyButton;
