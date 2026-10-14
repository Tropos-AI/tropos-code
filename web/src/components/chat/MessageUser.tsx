// web/src/components/chat/MessageUser.tsx — the user's message: right-aligned on a stone well, radius 14. A leading
// slash command shows as typed, set in the accent so `/review src/a.ts` reads as a command.
import { memo } from "react";

const LEADING_COMMAND = /^(\/[^\s/]+)(\s[\s\S]*)?$/;

export const MessageUser = memo(function MessageUser({ text }: { text: string }) {
  const command = LEADING_COMMAND.exec(text);
  return (
    <article aria-label="You" className="flex justify-end">
      <div className="max-w-[min(85%,620px)] whitespace-pre-wrap break-words rounded-[14px] border border-rule/70 bg-paper-2 px-4 py-2.5 text-[15px] leading-[1.6] text-ink shadow-well">
        {command ? (
          <>
            <span className="font-mono text-[0.9em] font-medium text-accent-ink">{command[1]}</span>
            {command[2] ?? ""}
          </>
        ) : (
          text
        )}
      </div>
    </article>
  );
});
