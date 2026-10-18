// web/src/components/pages/panel-head.tsx — the top of a tab panel: one line saying what the tab is, and the tab's actions
// (Refresh, Add …) on the right. Wraps below 640px so nothing overflows at 320px.
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function PanelHead({ description, actions, className }: { description?: ReactNode; actions?: ReactNode; className?: string }) {
  if (!description && !actions) return null;
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
      {description ? <p className="min-w-0 max-w-[60ch] flex-1 basis-64 text-[13.5px] leading-relaxed text-ink-2">{description}</p> : null}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** The column every tab panel's content sits in. */
export function PanelStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-w-0 flex-col gap-6", className)}>{children}</div>;
}
