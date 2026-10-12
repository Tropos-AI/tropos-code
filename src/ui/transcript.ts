import type { AgentEvent, ToolStatus } from "../agent/events";
import type { MessageParam } from "../session/store";
import type { ToolOutput } from "../tools/types";

export type TranscriptItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "thinking"; text: string }
  | { id: string; kind: "tool"; toolUseId: string; name: string; summary: string; status: "running" | ToolStatus; output?: ToolOutput }
  | { id: string; kind: "notice"; level: "info" | "warn" | "error"; text: string };

type NewItem = TranscriptItem extends infer T ? (T extends TranscriptItem ? Omit<T, "id"> : never) : never;

export interface Transcript {
  done: TranscriptItem[];
  live: TranscriptItem[];
  seq: number;
}

export const emptyTranscript: Transcript = { done: [], live: [], seq: 0 };

function make(t: Transcript, item: NewItem): { t: Transcript; item: TranscriptItem } {
  return { t: { ...t, seq: t.seq + 1 }, item: { ...item, id: `i${t.seq}` } as TranscriptItem };
}

export function flush(t: Transcript): Transcript {
  return t.live.length === 0 ? t : { ...t, done: [...t.done, ...t.live], live: [] };
}

/** Moves finished items at the front of `live` into `done`. A trailing text item may still be streaming. */
function settle(t: Transcript): Transcript {
  let n = 0;
  while (n < t.live.length) {
    const item = t.live[n]!;
    if (item.kind === "tool" && item.status === "running") break;
    const isLast = n === t.live.length - 1;
    if (isLast && (item.kind === "assistant" || item.kind === "thinking")) break;
    n++;
  }
  return n === 0 ? t : { ...t, done: [...t.done, ...t.live.slice(0, n)], live: t.live.slice(n) };
}

function pushLive(t: Transcript, item: NewItem): Transcript {
  const made = make(t, item);
  return { ...made.t, live: [...made.t.live, made.item] };
}

function pushDone(t: Transcript, item: NewItem): Transcript {
  const made = make(t, item);
  return { ...made.t, done: [...made.t.done, made.item] };
}

export function addUser(t: Transcript, text: string): Transcript {
  return pushDone(flush(t), { kind: "user", text });
}

export function addNotice(t: Transcript, level: "info" | "warn" | "error", text: string): Transcript {
  return pushLive(t, { kind: "notice", level, text });
}

export function reduce(t: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case "text":
    case "thinking": {
      const kind = event.type === "text" ? "assistant" : "thinking";
      const last = t.live.at(-1);
      if (last && (last.kind === "assistant" || last.kind === "thinking") && last.kind === kind) {
        return { ...t, live: [...t.live.slice(0, -1), { ...last, text: last.text + event.delta }] };
      }
      return settle(pushLive(t, { kind, text: event.delta }));
    }
    case "tool_start":
      return settle(pushLive(t, { kind: "tool", toolUseId: event.id, name: event.name, summary: event.summary, status: "running" }));
    case "tool_end":
      return settle({
        ...t,
        live: t.live.map((i) => (i.kind === "tool" && i.toolUseId === event.id ? { ...i, status: event.status, output: event.output } : i)),
      });
    case "notice":
      return addNotice(t, event.level, event.text);
    case "turn_end":
      return flush(t);
    default:
      return t;
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "command", "pattern"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

/** Context and mode blocks are injected by the harness; they are not part of what the user typed. */
function isInjected(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<context>") || trimmed.startsWith("<mode>");
}

/** Rebuilds a read-only transcript from a saved session. */
export function historyToTranscript(messages: MessageParam[]): Transcript {
  let t = emptyTranscript;
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.role === "user") {
        if (!isInjected(m.content)) t = addUser(t, m.content);
      } else {
        t = pushDone(t, { kind: "assistant", text: m.content });
      }
      continue;
    }
    for (const block of m.content) {
      if (m.role === "user" && block.type === "text" && !isInjected(block.text)) {
        t = addUser(t, block.text);
      } else if (m.role === "assistant" && block.type === "text") {
        t = pushDone(t, { kind: "assistant", text: block.text });
      } else if (m.role === "assistant" && block.type === "tool_use") {
        t = pushDone(t, { kind: "tool", toolUseId: block.id, name: block.name, summary: summarizeInput(block.input), status: "done" });
      }
    }
  }
  return t;
}
