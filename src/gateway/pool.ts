// src/gateway/pool.ts — chat key → session. A session is a WebHost (src/web/host.ts) seen through ChatSession.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PermissionAnswer } from "../agent/events";
import type { ServerMessage } from "../web/protocol";
import type { WebHost } from "../web/host";
import type { ChatSession, ChatSink, SessionProvider } from "./types";

/** What the pool needs from whoever builds a session (the daemon builds the real one). */
export interface HostHandle {
  host: WebHost;
  sessionId(): string;
  /** Ends the session and releases what it holds (its container). */
  close(): Promise<void>;
}

export interface PoolOptions {
  /** Builds the session for a chat; `savedSessionId` is the one this chat had last, to resume. */
  create(key: string, savedSessionId: string | undefined): Promise<HostHandle>;
  /** JSON file that remembers which session each chat had, so a restart resumes it. */
  statePath: string;
  idleMs: number;
  now?: () => number;
  /** How often idle sessions are looked for; 0 turns the timer off (tests call sweep themselves). */
  sweepEveryMs?: number;
}

interface Entry {
  handle: HostHandle;
  chat: ChatSession;
  lastActive: number;
}

export class SessionPool implements SessionProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Map<string, Promise<ChatSession>>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private sweeping: Promise<string[]> | undefined;

  constructor(private readonly opts: PoolOptions) {
    this.now = opts.now ?? Date.now;
    const every = opts.sweepEveryMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.sweep().catch(() => {}), every);
      this.timer.unref();
    }
  }

  open(key: string): Promise<ChatSession> {
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastActive = this.now();
      return Promise.resolve(existing.chat);
    }
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.build(key).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  private async build(key: string): Promise<ChatSession> {
    const saved = (await this.readState())[key];
    const handle = await this.opts.create(key, saved);
    const entry: Entry = { handle, chat: undefined as unknown as ChatSession, lastActive: this.now() };
    entry.chat = this.wrap(key, entry);
    this.entries.set(key, entry);
    await this.remember(key, handle.sessionId());
    return entry.chat;
  }

  /** Ends a chat's session; its final learning review runs first unless `finalReview` is false. */
  close(key: string, opts?: { finalReview?: boolean }): Promise<void> {
    return this.closeEntry(key, opts);
  }

  /** The gateway is stopping: no final reviews, so a stop never waits on them. */
  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.entries.keys()].map((key) => this.closeEntry(key, { finalReview: false })));
  }

  private async closeEntry(key: string, opts?: { finalReview?: boolean }): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.handle.host.shutdown(opts).catch(() => {});
    await entry.handle.close().catch(() => {});
  }

  /**
   * Closes sessions that have been quiet for the idle time and are not working. One sweep at a time: closing
   * runs final reviews, so a sweep can take a while.
   */
  sweep(): Promise<string[]> {
    this.sweeping ??= this.runSweep().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async runSweep(): Promise<string[]> {
    const closed: string[] = [];
    for (const [key, entry] of [...this.entries]) {
      // Closed and reopened while this sweep closed others: the fresh session is not the idle one seen here.
      if (this.entries.get(key) !== entry) continue;
      if (entry.handle.host.state().busy || this.now() - entry.lastActive < this.opts.idleMs) continue;
      await this.close(key);
      closed.push(key);
    }
    return closed;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  private wrap(key: string, entry: Entry): ChatSession {
    const touch = () => {
      entry.lastActive = this.now();
    };
    const { host } = entry.handle;
    return {
      key,
      prompt: async (text) => {
        touch();
        try {
          return await host.call("prompt", { text });
        } finally {
          touch();
        }
      },
      interrupt: () => {
        touch();
        void host.call("interrupt", undefined);
      },
      clear: async () => {
        touch();
        await host.call("clear", undefined);
        await this.remember(key, entry.handle.sessionId());
      },
      state: () => host.state(),
      answer: (id, answer: PermissionAnswer) => {
        touch();
        // A chat can only approve or deny: a saved "always allow" rule would outlive the chat.
        const safe: PermissionAnswer = answer.kind === "allow" ? { kind: "allow" } : { kind: "deny" };
        void host.handle({ t: "permission", id, answer: safe }, () => {});
      },
      attach: (sink) => host.attach((message) => deliver(sink, message)),
    };
  }

  private async readState(): Promise<Record<string, string>> {
    try {
      const json = JSON.parse(await readFile(this.opts.statePath, "utf8")) as unknown;
      if (!json || typeof json !== "object") return {};
      return Object.fromEntries(Object.entries(json).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      return {};
    }
  }

  /** Serialised, so two chats saving at once don't lose each other's entry. */
  private remember(key: string, sessionId: string): Promise<void> {
    const run = async () => {
      const state = await this.readState();
      if (state[key] === sessionId) return;
      state[key] = sessionId;
      await mkdir(dirname(this.opts.statePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.opts.statePath}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.opts.statePath);
    };
    this.saving = this.saving.then(run, run);
    return this.saving.catch(() => {});
  }
}

/** Maps the web protocol's messages to what a channel sink understands; the rest (hello, user echo, rpc results) is the web's. */
function deliver(sink: ChatSink, message: ServerMessage): void {
  switch (message.t) {
    case "event":
      return sink.event(message.event);
    case "ask":
      return sink.ask(message.id, message.prompt);
    case "ask_closed":
      return sink.askClosed(message.id);
    case "state":
      return sink.state(message.state);
    default:
      return;
  }
}
