// web/src/components/ui/badge.tsx — status pills. Colour is never the only signal: every badge carries a word.
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type BadgeTone = "ok" | "warn" | "error" | "off" | "neutral" | "accent" | "violet";

const TONE: Record<BadgeTone, { face: string; dot: string }> = {
  ok: { face: "bg-ok-wash text-ok border-ok/15", dot: "bg-ok" },
  warn: { face: "bg-warn-wash text-warn border-warn/15", dot: "bg-warn" },
  error: { face: "bg-error-wash text-error border-error/15", dot: "bg-error" },
  off: { face: "bg-paper-2 text-ink-2 border-rule", dot: "bg-ink-4" },
  neutral: { face: "bg-surface text-ink-2 border-rule", dot: "bg-ink-3" },
  accent: { face: "bg-accent-wash text-accent-ink border-accent/15", dot: "bg-accent" },
  violet: { face: "bg-violet-wash text-violet border-violet/15", dot: "bg-violet" },
};

type Props = {
  tone?: BadgeTone;
  children: ReactNode;
  /** Show the leading status dot. */
  dot?: boolean;
  className?: string;
};

export function Badge({ tone = "neutral", children, dot = true, className }: Props) {
  const t = TONE[tone];
  return (
    <span className={cn("inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11.5px] font-medium leading-none whitespace-nowrap", t.face, className)}>
      {dot ? <span aria-hidden className={cn("size-1.5 rounded-full", t.dot)} /> : null}
      {children}
    </span>
  );
}
