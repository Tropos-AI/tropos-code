// web/src/components/ui/card.tsx — Interior's white card: hairline border, shadow-card, radius 14.
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type Props = {
  children?: ReactNode;
  as?: "div" | "section" | "article" | "li" | "aside";
  className?: string;
  /** Remove the inner padding (for lists and tables that run edge to edge). */
  flush?: boolean;
  "aria-labelledby"?: string;
  "aria-label"?: string;
};

export function Card({ children, as: Tag = "div", className, flush, ...aria }: Props) {
  return (
    <Tag {...aria} className={cn("rounded-[14px] border border-rule bg-surface shadow-card", !flush && "p-5", className)}>
      {children}
    </Tag>
  );
}

/** A hairline-separated header row inside a flush Card. */
export function CardHeader({ children, className }: { children?: ReactNode; className?: string }) {
  return <header className={cn("flex items-center gap-3 border-b border-rule px-5 py-3.5", className)}>{children}</header>;
}
