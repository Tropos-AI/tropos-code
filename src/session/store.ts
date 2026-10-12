// src/session/store.ts
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectKey } from "../paths";

export type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface SessionMeta {
  sessionId: string;
  cwd: string;
  model: string;
  version: string;
  createdAt: string;
  title?: string;
}

type SessionLine =
  | ({ type: "meta" } & Partial<SessionMeta>)
  | { type: "message"; message: MessageParam; ts: string }
  | { type: "event"; name: string; value: unknown; ts: string };

/** Sessions for one project live under <home>/projects/<projectKey(cwd)> (see src/paths.ts). */
export function projectDir(home: string, cwd: string): string {
  return join(home, "projects", projectKey(cwd));
}

/** Transcripts can hold code and secrets: directories and files are owner-only. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TITLE_MAX = 60;

function titleFrom(message: MessageParam): string | undefined {
  if (message.role !== "user" || typeof message.content === "string") {
    return typeof message.content === "string" ? clip(message.content) : undefined;
  }
  for (const block of message.content) {
    if (block.type !== "text") continue;
    const text = block.text.trim();
    if (text.startsWith("<context>") || text.startsWith("<mode>")) continue;
    return clip(text);
  }
  return undefined;
}

function clip(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/** If the history ends with tool_use blocks that never got results, the user message that closes them. */
export function danglingToolResults(messages: MessageParam[]): MessageParam | null {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || typeof last.content === "string") return null;
  const ids = last.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
  if (ids.length === 0) return null;
  return {
    role: "user",
    content: ids.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "Not run: the session ended before this tool call finished.",
      is_error: true,
    })),
  };
}

export async function readSessionFile(path: string): Promise<{ meta: Partial<SessionMeta>; messages: MessageParam[] }> {
  const text = await readFile(path, "utf8");
  const meta: Partial<SessionMeta> = {};
  const messages: MessageParam[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: SessionLine;
    try {
      line = JSON.parse(raw) as SessionLine;
    } catch {
      continue; // a line cut short by a crash
    }
    if (line.type === "meta") {
      const { type: _type, ...rest } = line;
      Object.assign(meta, rest);
    } else if (line.type === "message") {
      messages.push(line.message);
    }
  }
  return { meta, messages };
}

export class SessionStore {
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    readonly id: string,
    readonly path: string,
    private titled: boolean,
  ) {}

  static async create(home: string, meta: { cwd: string; model: string; version: string }): Promise<SessionStore> {
    const id = randomUUID();
    const dir = projectDir(home, meta.cwd);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const store = new SessionStore(id, join(dir, `${id}.jsonl`), false);
    await store.write({ type: "meta", sessionId: id, createdAt: new Date().toISOString(), ...meta });
    return store;
  }

  static async open(home: string, cwd: string, id: string) {
    if (!SESSION_ID.test(id)) throw new Error("Invalid session id");
    const path = join(projectDir(home, cwd), `${id}.jsonl`);
    if (!existsSync(path)) throw new Error(`No session ${id} for ${cwd}`);
    const { meta, messages } = await readSessionFile(path);
    const store = new SessionStore(id, path, meta.title !== undefined);
    const repair = danglingToolResults(messages);
    if (repair) {
      await store.appendMessage(repair);
      messages.push(repair);
    }
    return { store, messages, meta };
  }

  async appendMessage(message: MessageParam): Promise<void> {
    await this.write({ type: "message", message, ts: new Date().toISOString() });
    if (!this.titled) {
      const title = titleFrom(message);
      if (title) {
        this.titled = true;
        await this.write({ type: "meta", title });
      }
    }
  }

  async appendEvent(name: string, value: unknown): Promise<void> {
    await this.write({ type: "event", name, value, ts: new Date().toISOString() });
  }

  /** Appends one JSON line; writes are serialized so lines never interleave. */
  private write(line: SessionLine): Promise<void> {
    this.writes = this.writes.then(() => appendFile(this.path, `${JSON.stringify(line)}\n`, { mode: FILE_MODE }));
    return this.writes;
  }
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: Date;
  messageCount: number;
}

export async function listSessions(home: string, cwd: string): Promise<SessionSummary[]> {
  const dir = projectDir(home, cwd);
  const names = await readdir(dir).catch(() => [] as string[]);
  const summaries: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!SESSION_ID.test(id)) continue;
    const path = join(dir, name);
    const [info, contents] = await Promise.all([stat(path), readSessionFile(path)]);
    if (contents.messages.length === 0) continue; // never used (e.g. opened then abandoned)
    summaries.push({
      id,
      title: contents.meta.title ?? "(untitled)",
      updatedAt: info.mtime,
      messageCount: contents.messages.length,
    });
  }
  return summaries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
