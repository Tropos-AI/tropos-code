// web/src/components/pages/panel-empty.tsx — a panel's `empty` text as an EmptyState: the first sentence becomes the
// title, the rest the description, with paths and quoted settings keys set in mono.
import { Fragment, type ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { IconName } from "@/components/ui/icon";

const CODE = /((?:~|\.)?\/?(?:[\w.<>@-]+\/)+(?:[\w.<>@-]*[\w<>@-])?|"[^"]+")/g;

/** Text with paths and "quoted keys" rendered as inline code. */
export function withInlineCode(text: string): ReactNode {
  const parts = text.split(CODE);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code key={`c-${i}`} className="rounded-[5px] bg-paper-2 px-1 py-px font-mono text-[0.9em] text-ink shadow-[inset_0_0_0_1px_var(--rule)]">
        {part}
      </code>
    ) : (
      <Fragment key={`t-${i}`}>{part}</Fragment>
    ),
  );
}

/** "No skills yet. Add one at …" → ["No skills yet", "Add one at …"]. */
export function splitEmptyText(text: string): { title: string; rest: string } {
  const match = /^(.+?[.!?])\s+(.+)$/s.exec(text.trim());
  if (!match) return { title: text.trim().replace(/[.]$/, ""), rest: "" };
  return { title: match[1]!.replace(/[.]$/, ""), rest: match[2]! };
}

export function PanelEmpty({ text, icon, action }: { text: string; icon: IconName; action?: ReactNode }) {
  const { title, rest } = splitEmptyText(text);
  return (
    <Card>
      <EmptyState icon={icon} title={title} description={rest ? withInlineCode(rest) : undefined} action={action} />
    </Card>
  );
}
