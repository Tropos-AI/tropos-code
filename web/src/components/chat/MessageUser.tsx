// web/src/components/chat/MessageUser.tsx — the user's message: right-aligned on a stone well, radius 14. A leading
// slash command shows as typed, set in the accent so `/review src/a.ts` reads as a command. Images and files sent with
// it sit above the bubble, right-aligned; a message of images alone has no bubble.
import { memo } from "react";

import type { Attachment } from "@core/attachments/attachments";

import { AttachmentList } from "@/components/chat/Attachments";

const LEADING_COMMAND = /^(\/[^\s/]+)(\s[\s\S]*)?$/;

type Props = { text: string; attachments?: Attachment[] };

export const MessageUser = memo(function MessageUser({ text, attachments }: Props) {
  const command = LEADING_COMMAND.exec(text);
  const items = (attachments ?? []).map((attachment, i) => ({ key: i, attachment }));
  return (
    <article aria-label="You" className="flex flex-col items-end gap-2">
      <AttachmentList items={items} label="Sent with this message" size="lg" className="max-w-[min(85%,620px)] justify-end" />
      {text ? (
        <div data-bubble className="max-w-[min(85%,620px)] whitespace-pre-wrap break-words rounded-[14px] border border-rule/70 bg-paper-2 px-4 py-2.5 text-[15px] leading-[1.6] text-ink shadow-well">
          {command ? (
            <>
              <span className="font-mono text-[0.9em] font-medium text-accent-ink">{command[1]}</span>
              {command[2] ?? ""}
            </>
          ) : (
            text
          )}
        </div>
      ) : null}
    </article>
  );
});
