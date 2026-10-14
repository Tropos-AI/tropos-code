// web/src/components/chat/ThinkingRow.tsx — the model's thinking, collapsed to two lines with Interior Show More.
import { memo } from "react";

import { ShowMore } from "@/components/interior/show-more";
import { Icon } from "@/components/ui/icon";

export const ThinkingRow = memo(function ThinkingRow({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <section aria-label="Thinking" className="rounded-[12px] border border-rule/80 bg-surface px-3.5 pb-2 pt-2.5">
      <p className="flex items-center gap-2 text-[12.5px] font-medium text-ink-2">
        <span className={live ? "text-accent-ink" : "text-ink-3"}>
          <Icon name="brain" size="sm" />
        </span>
        {live ? "Thinking…" : "Thought process"}
      </p>
      <ShowMore lines={2} maxHeight={360} label="Thinking" moreLabel="Show thinking" lessLabel="Hide thinking" className="mt-1 [&>div:last-child:has(>button.invisible)]:hidden">
        <p className="whitespace-pre-wrap text-[13px] italic leading-relaxed text-ink-3">{text}</p>
      </ShowMore>
    </section>
  );
});
