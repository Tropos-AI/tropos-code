// web/src/components/chat/Transcript.tsx — the conversation in the 760px reading column. Rows are keyed by transcript
// item id and memoized: finished items keep their object identity, so only the live (streaming) rows re-render.
import { memo } from "react";

import type { TranscriptItem } from "@core/ui/transcript";

import { MessageAssistant } from "@/components/chat/MessageAssistant";
import { MessageUser } from "@/components/chat/MessageUser";
import { NoticeRow } from "@/components/chat/NoticeRow";
import { ThinkingRow } from "@/components/chat/ThinkingRow";
import { ToolCard } from "@/components/chat/ToolCard";
import { TurnDone } from "@/components/chat/TurnDone";
import { cn } from "@/lib/utils";

/** The Tropos mark that opens each run of agent output. */
export function AgentMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-7 place-items-center rounded-[9px] border border-rule bg-surface shadow-card", className)}>
      <img src="/brand/tropos-logo.png" alt="" width={18} height={18} className="size-[18px] select-none" draggable={false} />
    </span>
  );
}

/** Vertical rhythm: wide gaps between speakers, tight between consecutive tool calls. */
function gapBefore(prev: TranscriptItem | undefined, item: TranscriptItem): string {
  if (!prev) return "";
  if (item.kind === "user") return "mt-9";
  if (prev.kind === "user") return "mt-6";
  if (item.kind === "tool" && prev.kind === "tool") return "mt-2";
  if (item.kind === "turn_done") return "mt-4";
  return "mt-3.5";
}

type RowProps = {
  item: TranscriptItem;
  gap: string;
  /** First item of an agent run: carries the Tropos mark. */
  leads: boolean;
  streaming: boolean;
  animateTodos: boolean;
  cwd?: string;
};

const Row = memo(function Row({ item, gap, leads, streaming, animateTodos, cwd }: RowProps) {
  if (item.kind === "user") {
    return (
      <li className={gap}>
        <MessageUser text={item.text} />
      </li>
    );
  }
  let content;
  switch (item.kind) {
    case "assistant":
      content = (
        <article aria-label="Tropos">
          <MessageAssistant text={item.text} streaming={streaming} />
        </article>
      );
      break;
    case "thinking":
      content = <ThinkingRow text={item.text} live={streaming} />;
      break;
    case "tool":
      content = <ToolCard item={item} cwd={cwd} animateTodos={animateTodos} />;
      break;
    case "notice":
      content = <NoticeRow level={item.level} text={item.text} />;
      break;
    case "turn_done":
      content = <TurnDone seconds={item.seconds} />;
      break;
  }
  return (
    <li className={cn("relative pl-10", gap)}>
      {leads ? <AgentMark className={cn("absolute left-0", item.kind === "assistant" ? "-top-0.5" : "top-1.5")} /> : null}
      {content}
    </li>
  );
});

type Props = {
  items: TranscriptItem[];
  /** Ids of items still in the transcript's live part (they may stream). */
  liveIds: ReadonlySet<string>;
  busy: boolean;
  cwd?: string;
};

export const Transcript = memo(function Transcript({ items, liveIds, busy, cwd }: Props) {
  const lastId = items.at(-1)?.id;
  let latestTodo: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "tool" && it.name === "TodoWrite") {
      latestTodo = it.id;
      break;
    }
  }
  return (
    <ol aria-label="Messages" className="flex flex-col">
      {items.map((item, i) => {
        const prev = items[i - 1];
        const leads = item.kind !== "user" && (!prev || prev.kind === "user");
        const streaming = busy && item.id === lastId && liveIds.has(item.id) && (item.kind === "assistant" || item.kind === "thinking");
        return <Row key={item.id} item={item} gap={gapBefore(prev, item)} leads={leads} streaming={streaming} animateTodos={busy && item.id === latestTodo} cwd={cwd} />;
      })}
    </ol>
  );
});
