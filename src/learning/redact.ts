// src/learning/redact.ts — keeps private tool results (other people's texts) out of the copy of the conversation the learning review reads
import { MESSAGES_TOOLS } from "../messages/runtime";
import type { MessageParam } from "../session/store";

/** What the review sees in place of a withheld result. */
export const WITHHELD = "[Messages result withheld from the learning review]";

/**
 * A copy of `history` in which every result of a call to one of `tools` reads `WITHHELD`, so no one's messages
 * end up in notes, skills or the journal. The calls themselves stay, so the review still knows what was done.
 * Messages that hold no such result are shared with the input, which is never changed.
 */
export function redactPrivateResults(history: MessageParam[], tools: ReadonlySet<string> = MESSAGES_TOOLS): MessageParam[] {
  const ids = new Set<string>();
  for (const message of history) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) if (block.type === "tool_use" && tools.has(block.name)) ids.add(block.id);
  }
  if (ids.size === 0) return [...history];
  return history.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    if (!message.content.some((b) => b.type === "tool_result" && ids.has(b.tool_use_id))) return message;
    return {
      ...message,
      content: message.content.map((b) => (b.type === "tool_result" && ids.has(b.tool_use_id) ? { ...b, content: WITHHELD } : b)),
    };
  });
}
