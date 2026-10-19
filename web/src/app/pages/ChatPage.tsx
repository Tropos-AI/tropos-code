// web/src/app/pages/ChatPage.tsx — the conversation: the transcript in a 760px reading
// column that keeps itself pinned to the newest output, the typing indicator while the agent works, Interior's New Items
// Pill when output arrives while the reader has scrolled up, and the composer pinned at the bottom.
import { useMemo, useState } from "react";

import "@/components/chat/chat.css";

import { Composer } from "@/components/chat/Composer";
import { AgentMark, Transcript } from "@/components/chat/Transcript";
import { useChatScroll } from "@/components/chat/use-chat-scroll";
import { NewItemsPill } from "@/components/interior/new-items-pill";
import { TypingIndicator } from "@/components/interior/typing-indicator";
import { Kbd } from "@/components/ui/kbd";
import { useBusy, useConnection, useHello, useHelloSeq, useTranscript } from "@/lib/store";

const STARTERS = [
  { label: "Explain how this project is put together", text: "Explain how this project is put together: the main parts and how they talk to each other." },
  { label: "Find and fix a failing test", text: "Run the tests, find what fails and fix it." },
  { label: "/init", text: "/init" },
];

function Welcome({ cwd, onPick }: { cwd?: string; onPick: (text: string) => void }) {
  return (
    <div className="flex min-h-[46vh] flex-col items-center justify-center px-2 text-center">
      <AgentMark className="size-11 rounded-[13px] [&>img]:size-7" />
      <h1 className="mt-5 text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink [font-stretch:88%]">What should we work on?</h1>
      {cwd ? <p className="mt-2 max-w-full truncate font-mono text-[12.5px] text-ink-3">{cwd}</p> : null}
      <ul aria-label="Suggestions" className="mt-7 flex max-w-[560px] flex-wrap justify-center gap-2">
        {STARTERS.map((starter) => (
          <li key={starter.label}>
            <button
              type="button"
              onClick={() => onPick(starter.text)}
              className="h-9 rounded-[10px] border border-rule bg-surface px-3.5 text-[13px] text-ink-2 shadow-raised outline-none transition-[background-color,color] duration-150 hover:bg-paper hover:text-ink focus-visible:shadow-focus active:translate-y-px"
            >
              {starter.label}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-6 hidden items-center gap-1.5 text-[12px] text-ink-3 sm:flex">
        Press <Kbd>/</Kbd> anywhere to type
      </p>
    </div>
  );
}

function Connecting() {
  return (
    <div className="flex min-h-[46vh] flex-col items-center justify-center gap-3 text-[13.5px] text-ink-2" role="status">
      <TypingIndicator typists={["tcode"]} showLabel={false} size={26} />
      Connecting to tcode…
    </div>
  );
}

export function ChatPage() {
  const transcript = useTranscript();
  const hello = useHello();
  const helloSeq = useHelloSeq();
  const busy = useBusy();
  const connection = useConnection();
  const [draft, setDraft] = useState("");

  const items = useMemo(() => [...transcript.done, ...transcript.live], [transcript]);
  const liveIds = useMemo(() => new Set(transcript.live.map((i) => i.id)), [transcript.live]);
  const { scrollRef, contentRef, unread, jump, pin } = useChatScroll(items.length, helloSeq, busy);

  const last = items.at(-1);
  const streamingText = busy && last !== undefined && liveIds.has(last.id) && last.kind === "assistant";
  const showDots = busy && !streamingText;

  // Announce the end of a turn once (the typing indicator announces the start).
  const [prevBusy, setPrevBusy] = useState(busy);
  const [announcement, setAnnouncement] = useState("");
  if (prevBusy !== busy) {
    setPrevBusy(busy);
    setAnnouncement(busy ? "" : "Tropos finished.");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <section aria-labelledby="chat-heading" className="relative min-h-0 flex-1">
        <h1 id="chat-heading" className="sr-only">
          Conversation
        </h1>
        <div ref={scrollRef} tabIndex={-1} className="scroll-quiet h-full overflow-y-auto outline-none" style={{ overflowAnchor: "none" }}>
          <div ref={contentRef} className="mx-auto w-full max-w-[760px] px-4 pb-6 pt-8 sm:px-6">
            {items.length === 0 ? (
              hello ? (
                <Welcome cwd={hello.cwd} onPick={setDraft} />
              ) : connection.everOpened ? null : (
                <Connecting />
              )
            ) : (
              <Transcript items={items} liveIds={liveIds} busy={busy} cwd={hello?.cwd} />
            )}
            {/* A fixed slot under the last item: the dots come and go without moving anything. */}
            <div className="mt-4 h-[30px] pl-10" aria-hidden={!showDots}>
              <TypingIndicator typists={showDots ? ["Tropos"] : []} showLabel={false} size={30} />
            </div>
          </div>
        </div>
        <NewItemsPill count={unread} onJump={jump} anchor="bottom" label={(n) => (n === 1 ? "New output below" : `${n} new items below`)} />
        <p role="status" className="sr-only">
          {announcement}
        </p>
      </section>

      <div className="relative shrink-0">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-t from-paper to-paper/0" />
        <div className="mx-auto w-full max-w-[760px] px-3 pb-3 pt-1 sm:px-6 sm:pb-5">
          <Composer value={draft} onValueChange={setDraft} onSubmitted={pin} />
        </div>
      </div>
    </div>
  );
}
