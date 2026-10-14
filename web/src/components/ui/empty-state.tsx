// web/src/components/ui/empty-state.tsx — what a page or list shows when there is nothing in it yet.
import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Props = {
  icon: IconName;
  title: string;
  description?: ReactNode;
  /** A Button, usually. */
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ icon, title, description, action, className }: Props) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      <span className="grid size-12 place-items-center rounded-[14px] border border-rule bg-surface text-ink-2 shadow-card">
        <Icon name={icon} size="lg" treatment="duotone" tone="accent" />
      </span>
      <h3 className="mt-4 text-[15px] font-medium tracking-[-0.01em] text-ink">{title}</h3>
      {description ? <p className="mt-1.5 max-w-[42ch] text-[13.5px] leading-relaxed text-ink-2">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
