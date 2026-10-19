// src/agents/activity.ts — what every agent in this process is doing right now: the chief in each chat (web/host.ts)
// and the specialists it delegates to (delegate.ts). The dashboard server relays it to every logged-in tab. No Node
// imports: the browser app imports the types through web/protocol.ts.
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from "../agent/events";

export type AgentRunState = "working" | "waiting";

/** One running agent as the dashboard shows it. Never a secret or a full tool input: short, clipped lines only. */
export interface AgentRunView {
  id: string;
  kind: "chief" | "specialist";
  /** The chief's name, or the specialist's id. */
  agent: string;
  model: string;
  /** "waiting": a permission prompt it raised is open. */
  state: AgentRunState;
  /** The tool it called last, "Bash: bun test"; null once it writes again. */
  tool?: string | null;
  /** The last lines it is writing. */
  text?: string | null;
  /** What the chief asked a specialist to do, clipped. */
  task?: string;
  startedAt: number;
  /** The session it runs in; `chat` says where that conversation is (Dashboard, Telegram …). */
  session: { id: string; chat?: string };
}

export interface AgentRunEnd {
  id: string;
  kind: AgentRunView["kind"];
  agent: string;
  ok: boolean;
  /** One line. */
  result: string;
  startedAt: number;
  endedAt: number;
  session: AgentRunView["session"];
}

/** A delta carries only what changed; null clears a field. */
export type ActivityEvent =
  | { type: "start"; run: AgentRunView }
  | { type: "delta"; id: string; state?: AgentRunState; tool?: string | null; text?: string | null }
  | { type: "end"; run: AgentRunEnd };

export interface ActivitySnapshot {
  running: AgentRunView[];
  /** The last run of each agent, newest first. */
  last: AgentRunEnd[];
}

export interface ActivityStart {
  kind: AgentRunView["kind"];
  agent: string;
  model: string;
  sessionId: string;
  /** Unset for a specialist: it takes the chat its session's chief named. */
  chat?: string;
  task?: string;
}

/** The handle a runner reports through; every method is cheap and never throws. */
export interface ActivityRun {
  readonly id: string;
  tool(name: string, summary: string): void;
  text(delta: string): void;
  waiting(on: boolean): void;
  /** Only the first call counts. */
  end(ok: boolean, result: string): void;
}

type Delta = Omit<Extract<ActivityEvent, { type: "delta" }>, "type" | "id">;

export interface AgentActivityOptions {
  now?: () => number;
  /** At most one update per run per interval (~10 a second by default). */
  intervalMs?: number;
  /** Runs `fn` after `ms`; returns a cancel. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const TOOL_CHARS = 80;
const TASK_CHARS = 120;
const RESULT_CHARS = 140;
const LINE_CHARS = 160;
const TEXT_LINES = 2;
/** Enough of what it writes to find the last lines in. */
const BUFFER_CHARS = 2_000;
const MAX_LAST = 50;
const MAX_CHATS = 200;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The first non-empty line, whitespace collapsed, clipped to `max`. */
export function oneLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return clip(line.replace(/\s+/g, " ").trim(), max);
}

/** The last lines of what an agent is writing, each clipped from the left (the newest words stay). */
export function tailLines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-TEXT_LINES)
    .map((l) => (l.length > LINE_CHARS ? `…${l.slice(-(LINE_CHARS - 1))}` : l))
    .join("\n");
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  // A pending update must never keep the process alive.
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

let nextRun = 1;

export class AgentActivity {
  private readonly listeners = new Set<(event: ActivityEvent) => void>();
  private readonly running = new Map<string, AgentRunView>();
  /** Newest last; keyed by kind and agent. */
  private readonly last = new Map<string, AgentRunEnd>();
  /** The chat each session was last seen in, for the specialists it starts. */
  private readonly chats = new Map<string, string>();
  private readonly now: () => number;
  private readonly interval: number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(opts: AgentActivityOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.interval = opts.intervalMs ?? 100;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): ActivitySnapshot {
    return { running: [...this.running.values()].map((r) => ({ ...r })), last: [...this.last.values()].reverse() };
  }

  start(input: ActivityStart): ActivityRun {
    if (input.chat) {
      this.chats.delete(input.sessionId);
      this.chats.set(input.sessionId, input.chat);
      if (this.chats.size > MAX_CHATS) this.chats.delete(this.chats.keys().next().value!);
    }
    const chat = input.chat ?? this.chats.get(input.sessionId);
    const view: AgentRunView = {
      id: `run-${nextRun++}`,
      kind: input.kind,
      agent: input.agent,
      model: input.model,
      state: "working",
      ...(input.task ? { task: oneLine(input.task, TASK_CHARS) } : {}),
      startedAt: this.now(),
      session: { id: input.sessionId, ...(chat ? { chat } : {}) },
    };
    this.running.set(view.id, view);
    this.emit({ type: "start", run: { ...view } });

    let buffer = "";
    let pending: Delta | null = null;
    let lastSent = Number.NEGATIVE_INFINITY;
    let cancel: (() => void) | null = null;
    let ended = false;

    const flush = () => {
      cancel = null;
      if (!pending || ended) return;
      const delta = pending;
      pending = null;
      lastSent = this.now();
      this.emit({ type: "delta", id: view.id, ...delta });
    };
    const update = (patch: Delta) => {
      if (ended) return;
      Object.assign(view, patch);
      pending = { ...pending, ...patch };
      if (cancel) return;
      const wait = lastSent + this.interval - this.now();
      if (wait <= 0) flush();
      else cancel = this.schedule(flush, wait);
    };

    return {
      id: view.id,
      tool: (name, summary) => {
        buffer = "";
        update({ tool: oneLine(`${name}: ${summary}`.replace(/: $/, ""), TOOL_CHARS), text: null });
      },
      text: (delta) => {
        if (!delta) return;
        buffer = (buffer + delta).slice(-BUFFER_CHARS);
        update({ ...(view.tool ? { tool: null } : {}), text: tailLines(buffer) });
      },
      waiting: (on) => {
        const state: AgentRunState = on ? "waiting" : "working";
        if (view.state !== state) update({ state });
      },
      end: (ok, result) => {
        if (ended) return;
        ended = true;
        cancel?.();
        pending = null;
        this.running.delete(view.id);
        const end: AgentRunEnd = {
          id: view.id,
          kind: view.kind,
          agent: view.agent,
          ok,
          result: oneLine(result, RESULT_CHARS),
          startedAt: view.startedAt,
          endedAt: this.now(),
          session: view.session,
        };
        const key = `${end.kind}:${end.agent}`;
        this.last.delete(key);
        this.last.set(key, end);
        if (this.last.size > MAX_LAST) this.last.delete(this.last.keys().next().value!);
        this.emit({ type: "end", run: end });
      },
    };
  }

  private emit(event: ActivityEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // a closing socket; the server drops it on close
      }
    }
  }
}

/** Feeds what an agent writes and the tools it calls into its run; nothing else of the event (never a tool's input). */
export function follow(run: ActivityRun, event: AgentEvent): void {
  if (event.type === "text") run.text(event.delta);
  else if (event.type === "tool_start") run.tool(event.name, event.summary);
}

type Ask = (prompt: PermissionPrompt, signal: AbortSignal) => Promise<PermissionAnswer>;

/** An askPermission that shows the run as waiting while any of its prompts is open. */
export function waitingWhileAsking(run: ActivityRun, ask: Ask): Ask {
  let open = 0;
  return async (prompt, signal) => {
    open++;
    run.waiting(true);
    try {
      return await ask(prompt, signal);
    } finally {
      open--;
      if (open === 0) run.waiting(false);
    }
  };
}

/** The process's one feed: chats (gateway, `tcode web`) and the dashboard server share it. */
export const agentActivity = new AgentActivity();
