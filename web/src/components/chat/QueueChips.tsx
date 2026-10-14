// web/src/components/chat/QueueChips.tsx — messages typed while a turn runs, shown as chips above the composer: click one
// to edit it (it leaves the queue and goes back into the input), × to drop it. After an interrupt the queue pauses.
import { AnimatePresence, m } from "motion/react";

import type { QueuedMessage } from "@/lib/app-state";
import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

type Props = {
  items: QueuedMessage[];
  paused: boolean;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (id: number) => void;
  onResume: () => void;
  onDiscard: () => void;
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function QueueChips({ items, paused, onEdit, onRemove, onResume, onDiscard }: Props) {
  const reduced = usePrefersReducedMotion();
  if (items.length === 0) return null;
  return (
    <section aria-label="Queued messages" className="mb-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-1 text-[12px]">
        <span className={cn("inline-flex items-center gap-1.5 font-medium", paused ? "text-warn" : "text-ink-2")}>
          <Icon name={paused ? "pause" : "clock"} size="sm" />
          {paused ? "Paused after interrupt" : `Queued · ${items.length === 1 ? "runs" : "run"} after this turn`}
        </span>
        {paused ? (
          <span className="ml-auto flex items-center gap-1">
            <button type="button" onClick={onResume} className="h-6 rounded-[6px] px-2 font-medium text-accent-ink outline-none hover:bg-accent-wash focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]">
              Send now
            </button>
            <button type="button" onClick={onDiscard} className="h-6 rounded-[6px] px-2 font-medium text-ink-2 outline-none hover:bg-paper-2 focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]">
              Discard
            </button>
          </span>
        ) : null}
      </div>
      <ol className="flex flex-wrap gap-1.5">
        <AnimatePresence initial={false}>
          {items.map((item, i) => (
            <m.li
              key={item.id}
              layout={!reduced}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduced ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
              transition={reduced ? INSTANT : CELL}
              className={cn(
                "flex h-8 max-w-full items-center rounded-[9px] border bg-surface pl-1 pr-0.5 shadow-raised",
                paused ? "border-warn/25" : "border-rule",
              )}
            >
              <button
                type="button"
                onClick={() => onEdit(item)}
                title={`Edit: ${item.text}`}
                aria-label={`Edit queued message ${i + 1}: ${oneLine(item.text)}`}
                className="flex h-7 min-w-0 items-center gap-1.5 rounded-[7px] px-1.5 text-[12.5px] text-ink outline-none hover:bg-paper-2 focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
              >
                <span aria-hidden className="font-mono text-[10.5px] tabular-nums text-ink-3">
                  {i + 1}
                </span>
                <span className="max-w-[28ch] truncate sm:max-w-[42ch]">{oneLine(item.text)}</span>
              </button>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                aria-label={`Remove queued message ${i + 1}`}
                className="grid size-7 shrink-0 place-items-center rounded-[7px] text-ink-3 outline-none hover:bg-paper-2 hover:text-ink focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
              >
                <Icon name="x" size="sm" />
              </button>
            </m.li>
          ))}
        </AnimatePresence>
      </ol>
    </section>
  );
}
