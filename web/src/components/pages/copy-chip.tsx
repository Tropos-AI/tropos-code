// web/src/components/pages/copy-chip.tsx — compact copy controls built on Interior's useCopyToClipboard: an icon button
// for paths and ids, and a "/name" chip that copies the slash command. Both crossfade copy → check with Interior springs.
import { m } from "motion/react";

import { useCopyToClipboard, type CopyStatus } from "@/components/interior/copy-button";
import { Icon, type IconName } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, CROSSFADE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

const GLYPHS: Array<[CopyStatus, IconName]> = [
  ["idle", "copy"],
  ["copied", "check"],
  ["error", "x"],
];

function CopyGlyph({ status }: { status: CopyStatus }) {
  const reduced = usePrefersReducedMotion();
  return (
    <span aria-hidden className="grid size-[14px] shrink-0 place-items-center">
      {GLYPHS.map(([key, name]) => (
        <m.span
          key={key}
          className={cn("col-start-1 row-start-1 grid place-items-center", key === "copied" && "text-ok", key === "error" && "text-error")}
          initial={false}
          animate={{ opacity: status === key ? 1 : 0, scale: status === key ? 1 : 0.6 }}
          transition={reduced ? INSTANT : CROSSFADE}
        >
          <Icon name={name} size="sm" />
        </m.span>
      ))}
    </span>
  );
}

function Announce({ status }: { status: CopyStatus }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {status === "copied" ? "Copied" : status === "error" ? "Copy failed" : ""}
    </span>
  );
}

type CopyIconButtonProps = {
  value: string;
  /** Accessible name, e.g. "Copy path". */
  label: string;
  className?: string;
};

/** A 28px square copy button for inline values (paths, ids, commands). */
export function CopyIconButton({ value, label, className }: CopyIconButtonProps) {
  const { copy, status } = useCopyToClipboard({ timeout: 1600 });
  const reduced = usePrefersReducedMotion();
  return (
    <m.button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void copy(value)}
      whileTap={reduced ? undefined : { scale: 0.92 }}
      transition={CELL}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-[8px] text-ink-3 outline-none transition-colors duration-150 hover:bg-paper-2 hover:text-ink focus-visible:text-ink focus-visible:shadow-focus",
        className,
      )}
    >
      <CopyGlyph status={status} />
      <Announce status={status} />
    </m.button>
  );
}

/** "/name" in a raised mono chip; pressing it copies the command. */
export function SlashChip({ command, className }: { command: string; className?: string }) {
  const { copy, status } = useCopyToClipboard({ timeout: 1600 });
  const reduced = usePrefersReducedMotion();
  return (
    <m.button
      type="button"
      onClick={() => void copy(command)}
      aria-label={`Copy ${command}`}
      title={`Copy ${command}`}
      whileTap={reduced ? undefined : { y: 1 }}
      transition={CELL}
      className={cn(
        "inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 rounded-[8px] border border-violet/15 bg-violet-wash pl-2 pr-1.5 font-mono text-[12px] text-violet shadow-raised outline-none transition-[border-color,box-shadow] duration-150 hover:border-violet/35 focus-visible:shadow-focus",
        className,
      )}
    >
      <span className="truncate">{command}</span>
      <span className="text-violet/70">
        <CopyGlyph status={status} />
      </span>
      <Announce status={status} />
    </m.button>
  );
}
