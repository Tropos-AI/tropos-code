// web/src/components/ui/section-heading.tsx — page and section titles: an optional uppercase eyebrow, a title, a
// description, and actions aligned to the right.
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type Props = {
  title: ReactNode;
  eyebrow?: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** h1 for a page title, h2/h3 for sections. */
  as?: "h1" | "h2" | "h3";
  id?: string;
  className?: string;
};

const SIZE = {
  h1: "text-[26px] font-medium leading-[1.1] tracking-[-0.02em] [font-stretch:88%]",
  h2: "text-[17px] font-medium leading-tight tracking-[-0.012em]",
  h3: "text-[14px] font-medium leading-tight",
} as const;

export function SectionHeading({ title, eyebrow, description, actions, as: Tag = "h2", id, className }: Props) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="type-meta mb-2 text-ink-3">{eyebrow}</p> : null}
        <Tag id={id} className={cn("text-ink", SIZE[Tag])}>
          {title}
        </Tag>
        {description ? <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
