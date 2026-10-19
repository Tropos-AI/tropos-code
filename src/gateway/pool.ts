// src/gateway/pool.ts — chat key → session. A session is a WebHost (src/web/host.ts) seen through ChatSession.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PermissionAnswer, TurnEndReason } from "../agent/events";
import { BUSY_ERROR, type RpcMap, type ServerMessage } from "../web/protocol";
import { RpcError, type WebHost } from "../web/host";
import { UnknownCommandError, UserFacingError } from "./errors";
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
  lastActive: number;
  /** Retired by a reload: closed (and replaced on the chat's next message) as soon as it is not busy. */
  retired?: boolean;
  /** The chat's sinks attached to this session's host, with their detach functions. */
  attached: Map<ChatSink, () => void>;
}

/** The one ChatSession a key ever hands out: it outlives the sessions behind it. */
interface Chat {
  chat: ChatSession;
  sinks: Set<ChatSink>;
  /** The session behind the chat now, or the one it had last. */
  last: Entry;
  /** Prompts waiting for a session to be (re)built, and whether /stop came meanwhile. */
  waiting: number;
  stopRequested: boolean;
}

export class SessionPool implements SessionProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Map<string, Promise<Entry>>();
  private readonly chats = new Map<string, Chat>();
  /** Sessions still shutting down, by key: a fresh one must not share the transcript with them. */
  private readonly closing = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private sweeping: Promise<string[]> | undefined;
  /** Counts retire() calls, so a session still being built during one is retired too. */
  private retirements = 0;
  private stopped = false;

  constructor(private readonly opts: PoolOptions) {
    this.now = opts.now ?? Date.now;
    const every = opts.sweepEveryMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.sweep().catch(() => {}), every);
      this.timer.unref();
    }
  }

  /**
   * The chat's session. The same ChatSession comes back for a key every time: when the session behind it is closed
   * (idle, revoked sender, reload), its next prompt opens a fresh one that resumes the transcript, and the attached
   * sinks move over to it.
   */
  async open(key: string): Promise<ChatSession> {
    const entry = await this.live(key);
    let chat = this.chats.get(key);
    if (!chat) {
      chat = { chat: undefined as unknown as ChatSession, sinks: new Set(), last: entry, waiting: 0, stopRequested: false };
      chat.chat = this.wrap(key, chat);
      this.chats.set(key, chat);
    }
    return chat.chat;
  }

  /** The key's open session; built when there is none, replaced when it was retired and its turn has ended. */
  private async live(key: string): Promise<Entry> {
    const entry = await this.liveOnce(key);
    // Once more when a reload overtook the build: nothing should start on what the reload replaced.
    return this.closable(entry) ? this.liveOnce(key) : entry;
  }

  private liveOnce(key: string): Promise<Entry> {
    if (this.stopped) return Promise.reject(new Error("The gateway is stopping."));
    const existing = this.entries.get(key);
    if (existing && !this.closable(existing)) {
      existing.lastActive = this.now();
      return Promise.resolve(existing);
    }
    let pending = this.opening.get(key);
    if (!pending) {
      // The last session is closed first (or finishes closing), so the fresh one never shares the transcript with it.
      const before = existing ? this.closeEntry(key, { finalReview: false }) : (this.closing.get(key) ?? Promise.resolve());
      pending = before.then(() => this.build(key)).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  private closable(entry: Entry): boolean {
    return entry.retired === true && !entry.handle.host.state().busy;
  }

  private async build(key: string): Promise<Entry> {
    const retirements = this.retirements;
    const saved = (await this.readState())[key];
    const handle = await this.opts.create(key, saved);
    // A reload while this was being built: it may stand on what the reload replaced, so it is retired too.
    const entry: Entry = { handle, lastActive: this.now(), retired: retirements !== this.retirements, attached: new Map() };
    this.entries.set(key, entry);
    const chat = this.chats.get(key);
    if (chat) {
      chat.last = entry;
      for (const sink of chat.sinks) this.attachSink(entry, sink);
    }
    await this.remember(key, handle.sessionId());
    return entry;
  }

  private attachSink(entry: Entry, sink: ChatSink): void {
    entry.attached.set(
      sink,
      entry.handle.host.attach((message) => deliver(sink, message)),
    );
  }

  /** Ends a chat's session; its final learning review runs first unless `finalReview` is false. */
  close(key: string, opts?: { finalReview?: boolean }): Promise<void> {
    return this.closeEntry(key, opts);
  }

  /**
   * The gateway reloaded: every session closes so that its chat's next message resumes it on the new contexts. A busy
   * one finishes its turn first, on what it has, and is closed once it is idle. No final review: the conversation
   * goes on in the resumed session.
   */
  async retire(): Promise<string[]> {
    this.retirements++;
    const closed: string[] = [];
    await Promise.all(
      [...this.entries].map(async ([key, entry]) => {
        entry.retired = true;
        if (entry.handle.host.state().busy) return;
        closed.push(key);
        await this.closeEntry(key, { finalReview: false });
      }),
    );
    return closed;
  }

  /** The gateway is stopping: no final reviews, so a stop never waits on them; sessions still being built close too. */
  async closeAll(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.opening.values()]);
    await Promise.all([...this.entries.keys()].map((key) => this.closeEntry(key, { finalReview: false })));
  }

  private closeEntry(key: string, opts?: { finalReview?: boolean }): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    this.entries.delete(key);
    const done = this.shutdown(entry, opts);
    this.closing.set(key, done);
    void done.then(() => {
      if (this.closing.get(key) === done) this.closing.delete(key);
    });
    return done;
  }

  private async shutdown(entry: Entry, opts?: { finalReview?: boolean }): Promise<void> {
    await entry.handle.host.shutdown(opts).catch(() => {});
    // After the shutdown, so what the final review reports still reaches the chat.
    for (const detach of entry.attached.values()) detach();
    entry.attached.clear();
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
      if (this.closable(entry)) {
        await this.close(key, { finalReview: false });
        closed.push(key);
        continue;
      }
      if (entry.handle.host.state().busy || this.now() - entry.lastActive < this.opts.idleMs) continue;
      await this.close(key);
      closed.push(key);
    }
    return closed;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * True while any chat works: a turn runs (a turn waiting for an approval included), a session opens, a prompt waits
   * for one, or a session is closing (its final review). The gateway restarts into an update only when this is false.
   */
  busy(): boolean {
    if (this.opening.size > 0 || this.closing.size > 0) return true;
    if ([...this.chats.values()].some((c) => c.waiting > 0)) return true;
    return [...this.entries.values()].some((e) => e.handle.host.state().busy);
  }

  private wrap(key: string, chat: Chat): ChatSession {
    /** The open session, or the closed one it had last (its state, its asks); never reopens. */
    const current = () => this.entries.get(key) ?? chat.last;
    const touch = (entry: Entry) => {
      entry.lastActive = this.now();
    };
    const turn = async (params: RpcMap["prompt"]["params"]): Promise<TurnEndReason> => {
      chat.waiting++;
      let entry: Entry;
      try {
        entry = await this.live(key);
      } catch (e) {
        if (chat.waiting === 1) chat.stopRequested = false;
        throw e;
      } finally {
        chat.waiting--;
      }
      // /stop arrived while the session was being built: the turn it would have stopped never starts.
      if (chat.stopRequested) {
        chat.stopRequested = false;
        return "aborted";
      }
      touch(entry);
      try {
        return await entry.handle.host.call("prompt", params);
      } finally {
        touch(entry);
      }
    };
    return {
      key,
      prompt: async (text, attachments) => {
        if (!attachments?.length) return turn({ text });
        try {
          return await turn({ text, attachments });
        } catch (e) {
          // A refused attachment (too big, not an image) is for the person at the chat; "busy" stays as is.
          if (e instanceof RpcError && e.message !== BUSY_ERROR) throw new UserFacingError(e.message);
          throw e;
        }
      },
      command: async (name, args) => {
        try {
          return await turn({ text: "", command: { name, args } });
        } catch (e) {
          // The host's reason (unknown name, a hook that refused) is for the person at the chat; "busy" stays as is.
          if (e instanceof RpcError && e.message !== BUSY_ERROR) {
            // The host words it exactly `/<name>: Unknown command /<name>.`; a reason that merely mentions it is a real failure.
            throw e.message === `/${name}: Unknown command /${name}.` ? new UnknownCommandError(e.message) : new UserFacingError(e.message);
          }
          throw e;
        }
      },
      learned: async () => {
        const entry = await this.live(key);
        touch(entry);
        return entry.handle.host.call("panel", "learned");
      },
      undoLearned: async () => {
        const entry = await this.live(key);
        touch(entry);
        try {
          return { ok: true, ...(await entry.handle.host.call("learned.undo", undefined)) };
        } catch (e) {
          if (e instanceof RpcError) return { ok: false, reason: e.message };
          throw e;
        }
      },
      interrupt: () => {
        if (chat.waiting > 0) chat.stopRequested = true;
        const entry = this.entries.get(key);
        if (!entry) return;
        touch(entry);
        void entry.handle.host.call("interrupt", undefined);
      },
      clear: async () => {
        const entry = await this.live(key);
        touch(entry);
        await entry.handle.host.call("clear", undefined);
        await this.remember(key, entry.handle.sessionId());
      },
      state: () => current().handle.host.state(),
      answer: (id, answer: PermissionAnswer) => {
        const entry = current();
        touch(entry);
        // A chat can only approve or deny: a saved "always allow" rule would outlive the chat.
        const safe: PermissionAnswer = answer.kind === "allow" ? { kind: "allow" } : { kind: "deny" };
        void entry.handle.host.handle({ t: "permission", id, answer: safe }, () => {});
      },
      attach: (sink) => {
        chat.sinks.add(sink);
        const entry = this.entries.get(key);
        if (entry) this.attachSink(entry, sink);
        return () => {
          chat.sinks.delete(sink);
          for (const e of new Set([this.entries.get(key), chat.last])) {
            e?.attached.get(sink)?.();
            e?.attached.delete(sink);
          }
        };
      },
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
