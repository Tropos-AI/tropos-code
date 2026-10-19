// src/session/store.ts
import type { SessionRole } from "../gateway/types";
import type Anthropic from "@anthropic-ai/sdk";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
  /** Subagent transcripts only: the session that started it, and the agent that ran. */
  parentId?: string;
  agent?: string;
  /** Who the session answered to; SessionSearch never shows a guest's transcript. Absent in older transcripts. */
  role?: SessionRole;
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
    if (text.startsWith("<context>") || text.startsWith("<mode>") || text.startsWith("<attachment ")) continue;
    return clip(text);
  }
  return undefined;
}

function clip(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/**
 * On disk an image is a reference to a file in `<session>.attachments/` (named by a hash of its bytes, so one image
 * is stored once); in memory it is inline base64 again. Inline base64 would make every line of the JSONL heavy.
 */
interface StoredImageSource {
  type: "tropos_file";
  media_type: string;
  file: string;
}

const IMAGE_FILE = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;
const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const IMAGE_GONE = "[image no longer available: its file was removed from the session folder]";

type ContentBlock = Exclude<MessageParam["content"], string>[number];
type ImageMap = (block: { type: "image"; source: unknown }) => unknown;

/** The message with every image block (also those inside tool results) replaced by `fn`'s result. */
function mapImages(message: MessageParam, fn: ImageMap): MessageParam {
  if (typeof message.content === "string") return message;
  const mapBlock = (block: ContentBlock): ContentBlock => {
    if (block.type === "image") return fn(block) as ContentBlock;
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return { ...block, content: block.content.map((b) => (b.type === "image" ? fn(b) : b)) } as ContentBlock;
    }
    return block;
  };
  return { ...message, content: message.content.map(mapBlock) };
}

/** The message as the JSONL stores it, and the image files to write first. */
function externalizeImages(message: MessageParam): { stored: MessageParam; files: Array<{ name: string; data: string }> } {
  const files: Array<{ name: string; data: string }> = [];
  const stored = mapImages(message, (block) => {
    const source = block.source as { type?: string; media_type?: string; data?: string };
    const ext = IMAGE_EXT[source.media_type ?? ""];
    if (source.type !== "base64" || !ext || typeof source.data !== "string") return block;
    const name = `${createHash("sha256").update(source.data).digest("hex").slice(0, 32)}.${ext}`;
    if (!files.some((f) => f.name === name)) files.push({ name, data: source.data });
    return { ...block, source: { type: "tropos_file", media_type: source.media_type!, file: name } satisfies StoredImageSource };
  });
  return { stored, files };
}

/** Loads the images a saved message refers to; one whose file is gone becomes a note, so the session still resumes. */
async function rehydrateImages(message: MessageParam, dir: string): Promise<MessageParam> {
  const refs: StoredImageSource[] = [];
  mapImages(message, (block) => {
    const source = block.source as StoredImageSource;
    if (source?.type === "tropos_file") refs.push(source);
    return block;
  });
  if (refs.length === 0) return message;
  const data = new Map<string, string | null>();
  for (const ref of refs) {
    if (data.has(ref.file)) continue;
    const ok = typeof ref.file === "string" && IMAGE_FILE.test(ref.file);
    data.set(ref.file, ok ? await readFile(join(dir, ref.file)).then((b) => b.toString("base64"), () => null) : null);
  }
  return mapImages(message, (block) => {
    const source = block.source as StoredImageSource;
    if (source?.type !== "tropos_file") return block;
    const base64 = data.get(source.file);
    return base64 ? { ...block, source: { type: "base64", media_type: source.media_type, data: base64 } } : { type: "text", text: IMAGE_GONE };
  });
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

function parseSession(text: string): { meta: Partial<SessionMeta>; messages: MessageParam[] } {
  const meta: Partial<SessionMeta> = {};
  const messages: MessageParam[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // a line cut short by a crash
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const line = parsed as SessionLine;
    if (line.type === "meta") {
      const { type: _type, ...rest } = line;
      Object.assign(meta, rest);
    } else if (line.type === "message" && typeof line.message === "object" && line.message !== null) {
      messages.push(line.message);
    }
  }
  return { meta, messages };
}

export async function readSessionFile(path: string): Promise<{ meta: Partial<SessionMeta>; messages: MessageParam[] }> {
  return parseSession(await readFile(path, "utf8"));
}

export class SessionStore {
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    readonly id: string,
    readonly path: string,
    private titled: boolean,
  ) {}

  static async create(home: string, meta: { cwd: string; model: string; version: string; role?: SessionRole }): Promise<SessionStore> {
    const id = randomUUID();
    const dir = projectDir(home, meta.cwd);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const store = new SessionStore(id, join(dir, `${id}.jsonl`), false);
    await store.write({ type: "meta", sessionId: id, createdAt: new Date().toISOString(), ...meta });
    return store;
  }

  /**
   * A subagent's transcript, kept beside its parent session so search can find it. It lives in a
   * subfolder, so listSessions and resume never see it.
   */
  static async createSubagent(
    home: string,
    meta: { cwd: string; parentId: string; agent: string; model: string; version: string; role?: SessionRole },
  ): Promise<SessionStore> {
    if (!SESSION_ID.test(meta.parentId)) throw new Error("Invalid session id");
    const id = randomUUID();
    const dir = join(projectDir(home, meta.cwd), "subagents", meta.parentId);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const store = new SessionStore(id, join(dir, `${id}.jsonl`), false);
    await store.write({ type: "meta", sessionId: id, createdAt: new Date().toISOString(), ...meta });
    return store;
  }

  static async open(home: string, cwd: string, id: string) {
    if (!SESSION_ID.test(id)) throw new Error("Invalid session id");
    const path = join(projectDir(home, cwd), `${id}.jsonl`);
    if (!existsSync(path)) throw new Error(`No session ${id} for ${cwd}`);
    const text = await readFile(path, "utf8");
    const store = new SessionStore(id, path, false);
    // A crash can leave a final line without "\n"; end it so the repair starts a fresh line.
    if (text.length > 0 && !text.endsWith("\n")) await store.appendRaw("\n");
    const parsed = parseSession(text);
    const meta = parsed.meta;
    const messages = await Promise.all(parsed.messages.map((m) => rehydrateImages(m, store.attachmentsDir)));
    store.titled = meta.title !== undefined;
    const repair = danglingToolResults(messages);
    if (repair) {
      await store.appendMessage(repair);
      messages.push(repair);
    }
    return { store, messages, meta };
  }

  /** Where this session's images are kept: beside the transcript, `<id>.attachments/`. */
  get attachmentsDir(): string {
    return this.path.replace(/\.jsonl$/, ".attachments");
  }

  async appendMessage(message: MessageParam): Promise<void> {
    const { stored, files } = externalizeImages(message);
    const line = `${JSON.stringify({ type: "message", message: stored, ts: new Date().toISOString() } satisfies SessionLine)}\n`;
    // In the same queued step as the line, so a line never names an image that isn't written yet.
    await this.chain(async () => {
      if (files.length > 0) {
        await mkdir(this.attachmentsDir, { recursive: true, mode: DIR_MODE });
        for (const file of files) {
          const path = join(this.attachmentsDir, file.name);
          if (!existsSync(path)) await writeFile(path, Buffer.from(file.data, "base64"), { mode: FILE_MODE });
        }
      }
      await appendFile(this.path, line, { mode: FILE_MODE });
    });
    if (!this.titled) {
      const title = titleFrom(message);
      if (title) {
        this.titled = true;
        await this.write({ type: "meta", title });
      }
    }
  }

  /** Records who the session answers to from now on: a resumed chat whose role changed, or an older transcript without one. */
  async recordRole(role: SessionRole): Promise<void> {
    await this.write({ type: "meta", role });
  }

  async appendEvent(name: string, value: unknown): Promise<void> {
    await this.write({ type: "event", name, value, ts: new Date().toISOString() });
  }

  /** Appends one JSON line; writes are serialized so lines never interleave. */
  private write(line: SessionLine): Promise<void> {
    return this.appendRaw(`${JSON.stringify(line)}\n`);
  }

  private appendRaw(text: string): Promise<void> {
    return this.chain(() => appendFile(this.path, text, { mode: FILE_MODE }));
  }

  /** Runs `op` after every earlier write. The chain keeps going after a failure; it is reported to this caller only. */
  private chain(op: () => Promise<void>): Promise<void> {
    const run = this.writes.then(op);
    this.writes = run.catch(() => {});
    return run;
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
    try {
      const [info, contents] = await Promise.all([stat(path), readSessionFile(path)]);
      if (contents.messages.length === 0) continue; // never used (e.g. opened then abandoned)
      summaries.push({
        id,
        title: contents.meta.title ?? "(untitled)",
        updatedAt: info.mtime,
        messageCount: contents.messages.length,
      });
    } catch {
      continue; // unreadable entry (e.g. a directory with a session-like name)
    }
  }
  return summaries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
