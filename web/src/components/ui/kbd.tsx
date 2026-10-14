// web/src/components/ui/kbd.tsx — a keycap for shortcut hints.
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] border border-rule bg-surface px-1.5 font-mono text-[11px] font-medium leading-none text-ink-2 shadow-[inset_0_-1px_0_var(--rule)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
