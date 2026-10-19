// src/ui/transcript.ts
import type { AgentEvent, ToolStatus } from "../agent/events";
import { parseAttachmentText, type Attachment } from "../attachments/attachments";
import type { MessageParam } from "../session/store";
import type { ToolOutput } from "../tools/types";

export type TranscriptItem =
  /** `attachments`: images and files sent with the message; absent when there are none. */
  | { id: string; kind: "user"; text: string; attachments?: Attachment[] }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "thinking"; text: string }
  | {
      id: string;
      kind: "tool";
      toolUseId: string;
      name: string;
      summary: string;
      status: "running" | ToolStatus;
      /** The tool's raw input, so rows can show per-tool headers (paths, patterns, todo lists). */
      input?: unknown;
      output?: ToolOutput;
      /** Latest progress line while running, e.g. a subagent's current tool. */
      progress?: string;
      /** How many progress lines arrived; a subagent sends one per tool it starts, so this counts its tool uses. */
      progressCount?: number;
    }
  | { id: string; kind: "notice"; level: "info" | "warn" | "error"; text: string }
  /** The footer after a finished turn: "Worked for 12s". */
  | { id: string; kind: "turn_done"; seconds: number };

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

export function addUser(t: Transcript, text: string, attachments: Attachment[] = []): Transcript {
  return pushDone(flush(t), { kind: "user", text, ...(attachments.length > 0 ? { attachments } : {}) });
}

export function addNotice(t: Transcript, level: "info" | "warn" | "error", text: string): Transcript {
  return pushLive(t, { kind: "notice", level, text });
}

/** Turns this short or shorter get no footer: a quick reply needs no "Worked for 2s". */
export const TURN_DONE_MIN_SECONDS = 5;

/** Adds the turn footer after everything the turn produced; a no-op for turns of TURN_DONE_MIN_SECONDS or less. */
export function addTurnDone(t: Transcript, seconds: number): Transcript {
  if (!(seconds > TURN_DONE_MIN_SECONDS)) return t;
  return pushDone(flush(t), { kind: "turn_done", seconds: Math.round(seconds) });
}

export function reduce(t: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case "text":
    case "thinking": {
      // An empty delta would open an empty item between two thinking deltas and split them into many rows.
      if (!event.delta) return t;
      const kind = event.type === "text" ? "assistant" : "thinking";
      const last = t.live.at(-1);
      if (last && (last.kind === "assistant" || last.kind === "thinking") && last.kind === kind) {
        return { ...t, live: [...t.live.slice(0, -1), { ...last, text: last.text + event.delta }] };
      }
      return settle(pushLive(t, { kind, text: event.delta }));
    }
    case "tool_start":
      return settle(pushLive(t, { kind: "tool", toolUseId: event.id, name: event.name, summary: event.summary, input: event.input, status: "running" }));
    case "tool_end":
      return settle({
        ...t,
        live: t.live.map((i) => (i.kind === "tool" && i.toolUseId === event.id ? { ...i, status: event.status, output: event.output } : i)),
      });
    case "tool_progress":
      return {
        ...t,
        live: t.live.map((i) =>
          i.kind === "tool" && i.toolUseId === event.id && i.status === "running" ? { ...i, progress: event.text, progressCount: (i.progressCount ?? 0) + 1 } : i,
        ),
      };
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

const INJECTED_PREFIXES = ["<context>", "<mode>", "<reminder>", "<hook-context"];

/** Context, mode, reminder and hook blocks are injected by the harness; they are not part of what the user typed. */
function isInjected(text: string): boolean {
  const trimmed = text.trimStart();
  return INJECTED_PREFIXES.some((p) => trimmed.startsWith(p));
}

/** A custom command or skill invocation is shown the way the user typed it: `/name args`. */
function displayedUserText(text: string): string {
  const m = /^<(?:command|skill) name="([^"]*)"(?: args="([^"]*)")?/.exec(text.trimStart());
  if (!m) return text;
  const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const name = unescape(m[1]!);
  const args = m[2] ? ` ${unescape(m[2])}` : "";
  return `${name.startsWith("/") ? name : `/${name}`}${args}`;
}

/** Rebuilds a read-only transcript from a saved session. */
export function historyToTranscript(messages: MessageParam[]): Transcript {
  let t = emptyTranscript;
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.role === "user") {
        if (!isInjected(m.content)) t = addUser(t, displayedUserText(m.content));
      } else {
        t = pushDone(t, { kind: "assistant", text: m.content });
      }
      continue;
    }
    // The user's files and images go with the typed text that follows them (or alone, when nothing was typed).
    let attached: Attachment[] = [];
    for (const block of m.content) {
      const file = m.role === "user" && block.type === "text" ? parseAttachmentText(block.text) : null;
      if (file) {
        attached.push({ kind: "text", ...file });
      } else if (m.role === "user" && block.type === "image" && block.source.type === "base64") {
        const n = attached.filter((a) => a.kind === "image").length + 1;
        attached.push({ kind: "image", name: `image ${n}`, mediaType: block.source.media_type, data: block.source.data });
      } else if (m.role === "user" && block.type === "text" && !isInjected(block.text)) {
        t = addUser(t, displayedUserText(block.text), attached);
        attached = [];
      } else if (m.role === "assistant" && block.type === "text") {
        t = pushDone(t, { kind: "assistant", text: block.text });
      } else if (m.role === "assistant" && block.type === "tool_use") {
        t = pushDone(t, { kind: "tool", toolUseId: block.id, name: block.name, summary: summarizeInput(block.input), input: block.input, status: "done" });
      }
    }
    if (attached.length > 0) t = addUser(t, "", attached);
  }
  return t;
}
