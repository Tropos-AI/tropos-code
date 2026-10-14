// web/src/app/layout/PageFrame.tsx — the scrolling frame every non-chat page sits in: a centred column, the page
// heading, then the page's sections. Chat manages its own layout (reading column + pinned composer).
import type { ReactNode } from "react";

import { SectionHeading } from "@/components/ui/section-heading";
import { cn } from "@/lib/utils";

type Props = {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** Column width; defaults to 960px. */
  width?: "reading" | "wide";
  className?: string;
};

export function PageFrame({ title, eyebrow, description, actions, children, width = "wide", className }: Props) {
  return (
    <div className="scroll-quiet h-full overflow-y-auto">
      <div className={cn("mx-auto w-full px-4 pb-16 pt-8 sm:px-8 lg:pt-10", width === "reading" ? "max-w-[760px]" : "max-w-[960px]", className)}>
        <SectionHeading as="h1" title={title} eyebrow={eyebrow} description={description} actions={actions} />
        <div className="mt-8 flex flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}
