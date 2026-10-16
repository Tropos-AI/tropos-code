// src/web/host.ts — one tcode session served to every browser tab: runs turns, relays the agent's events,
// and routes permission prompts to whichever tab answers first.
import type { Agent } from "../agent/agent";
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from "../agent/events";
import { contextWindow } from "../api/pricing";
import { EFFORTS, MODES, type Effort, type Mode } from "../config/constants";
import { errorText } from "../error-text";
import { completeFile } from "../ui/complete";
import type { ListTopic } from "../ui/commands";
import type { AgentUi, Runtime } from "../ui/runtime";
import type { ClientMessage, HelloInfo, ProviderInfoView, RpcMap, RpcMethod, ServerMessage, SessionState } from "./protocol";
import { BUSY_ERROR, RPC_METHODS } from "./protocol";

export type Send = (message: ServerMessage) => void;

const LIST_TOPICS: ListTopic[] = ["skills", "agents", "hooks", "mcp", "plugins", "memory", "learned"];

interface OpenAsk {
  prompt: PermissionPrompt;
  resolve(answer: PermissionAnswer): void;
}

/** A failed RPC: the message is shown to the user as is. */
export class RpcError extends Error {}

/**
 * Permission prompts are numbered across every host in the process: a dashboard tab that moved to another project's
 * host must not answer that host's prompt with an answer it meant for the old one.
 */
let nextAsk = 1;

export class WebHost {
  private readonly clients = new Set<Send>();
  private readonly asks = new Map<number, OpenAsk>();
  private agent: Agent;
  private controller: AbortController | null = null;
  private busy = false;
  private usage = { contextTokens: 0, totalCostUsd: 0 as number | undefined };
  private turns = 0;
  private turnStartedAt: number | undefined;
  private idleWaiters: Array<() => void> = [];
  private closed = false;
  /** A runtime swap in progress: a prompt sent meanwhile waits for it instead of failing as busy. */
  private swapping: Promise<void> | undefined;

  constructor(private runtime: Runtime) {
    this.agent = runtime.newAgent(this.ui);
  }

  /** What the agent and slash-command expansion use to talk to the browser. */
  private readonly ui: AgentUi = {
    emit: (event) => this.onEvent(event),
    askPermission: (prompt, signal) =>
      new Promise<PermissionAnswer>((resolve) => {
        if (signal.aborted) return resolve({ kind: "deny" });
        const id = nextAsk++;
        const close = (answer: PermissionAnswer) => {
          if (!this.asks.delete(id)) return;
          this.broadcast({ t: "ask_closed", id });
          resolve(answer);
        };
        this.asks.set(id, { prompt, resolve: close });
        signal.addEventListener("abort", () => close({ kind: "deny" }), { once: true });
        this.broadcast({ t: "ask", id, prompt });
      }),
  };

  /** Fires SessionStart; its messages go to every tab as notices. */
  async start(): Promise<void> {
    await this.runtime.start((level, text) => this.onEvent({ type: "notice", level, text })).catch(() => {});
  }

  async shutdown(opts?: { finalReview?: boolean }): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.runtime.shutdown(opts);
  }

  /** Resolves once no turn (or other busy operation) is running. */
  whenIdle(): Promise<void> {
    return this.busy ? new Promise((resolve) => this.idleWaiters.push(resolve)) : Promise.resolve();
  }

  /**
   * Moves the conversation onto the runtime `build` makes from the old one (the gateway reloaded its settings). A
   * running turn finishes on the old runtime first; prompts wait out the swap as busy. `build` returns undefined to
   * keep the old one; after shutdown nothing is swapped in.
   */
  async replaceRuntime(build: (old: Runtime) => Promise<Runtime | undefined>): Promise<void> {
    while (this.busy) await this.whenIdle();
    if (this.closed) return;
    const swap = this.exclusive(async () => {
      const next = await build(this.runtime);
      if (!next) return;
      if (this.closed) return void (await next.shutdown({ finalReview: false }).catch(() => {}));
      this.runtime = next;
      await next.start((level, text) => this.onEvent({ type: "notice", level, text })).catch(() => {});
      this.agent = next.newAgent(this.ui);
      this.broadcast({ t: "hello", server: this.hello() });
    });
    this.swapping = swap.catch(() => {});
    try {
      await swap;
    } finally {
      this.swapping = undefined;
    }
  }

  hello(): HelloInfo {
    return {
      version: this.runtime.version,
      cwd: this.runtime.cwd,
      sessionId: this.runtime.sessionId(),
      modes: this.runtime.modes,
      commands: this.runtime.extraCommands,
      // The live conversation, so a tab opened (or reloaded) mid-session shows it; runtime.history() is only the saved start.
      history: this.agent.messages,
      identity: this.runtime.identity(),
    };
  }

  state(): SessionState {
    const { model, effort, mode } = this.runtime.state();
    return {
      model,
      effort,
      mode,
      busy: this.busy,
      contextTokens: this.usage.contextTokens,
      contextWindow: contextWindow(model),
      totalCostUsd: this.usage.totalCostUsd,
      turns: this.turns,
      turnStartedAt: this.turnStartedAt,
      identity: this.runtime.identity(),
    };
  }

  /** A new tab: it gets the session, its state, and any prompt still waiting for an answer. */
  attach(send: Send): () => void {
    this.clients.add(send);
    send({ t: "hello", server: this.hello() });
    send({ t: "state", state: this.state() });
    for (const [id, ask] of this.asks) send({ t: "ask", id, prompt: ask.prompt });
    return () => this.clients.delete(send);
  }

  /** To every tab, or every tab but `except` (the one that sent what this reports). */
  private broadcast(message: ServerMessage, except?: Send): void {
    for (const send of this.clients) {
      if (send === except) continue;
      try {
        send(message);
      } catch {
        // a closing socket; it is removed when its close event arrives
      }
    }
  }

  private broadcastState(): void {
    this.broadcast({ t: "state", state: this.state() });
  }

  private onEvent(event: AgentEvent): void {
    if (event.type === "usage") {
      this.usage = { contextTokens: event.contextTokens, totalCostUsd: event.totalCostUsd };
      this.broadcast({ t: "event", event });
      return this.broadcastState();
    }
    this.broadcast({ t: "event", event });
  }

  /** Handles one message from a tab; RPC results go back to that tab only. */
  async handle(message: ClientMessage, reply: Send): Promise<void> {
    if (message.t === "permission") {
      this.asks.get(message.id)?.resolve(message.answer);
      return;
    }
    if (message.t !== "rpc" || !RPC_METHODS.includes(message.method)) {
      return reply({ t: "rpc_result", id: (message as { id?: number }).id ?? 0, ok: false, error: "Unknown request." });
    }
    try {
      const result = await this.call(message.method, message.params, reply);
      reply({ t: "rpc_result", id: message.id, ok: true, result: result ?? null });
    } catch (err) {
      reply({ t: "rpc_result", id: message.id, ok: false, error: err instanceof RpcError ? err.message : errorText(err) });
    }
  }

  private needIdle(): void {
    if (this.busy) throw new RpcError(BUSY_ERROR);
  }

  private resetAgent(): HelloInfo {
    this.agent = this.runtime.newAgent(this.ui);
    this.usage = { contextTokens: 0, totalCostUsd: 0 };
    this.turns = 0;
    const hello = this.hello();
    this.broadcast({ t: "hello", server: hello });
    this.broadcastState();
    return hello;
  }

  /** Runs `work` as the one busy operation, interruptible through `interrupt`. */
  private async exclusive<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.needIdle();
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    this.broadcastState();
    try {
      return await work(controller.signal);
    } finally {
      this.controller = null;
      this.busy = false;
      this.broadcastState();
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  /** `origin` is the tab that asked, when there is one: it already shows its own prompt. */
  async call<M extends RpcMethod>(method: M, raw: unknown, origin?: Send): Promise<RpcMap[M]["result"]> {
    const params = raw as RpcMap[M]["params"];
    // A request sent during a runtime swap waits for it, then reads the runtime: it must act on the one (and the
    // permissions) that replaced the old. Only when there is a swap: an await here would let one start before a turn.
    if (this.swapping && method !== "interrupt") await this.swapping;
    const r = this.runtime;
    switch (method) {
      case "prompt": {
        const p = params as RpcMap["prompt"]["params"];
        const command = p?.command && typeof p.command.name === "string" ? { name: p.command.name, args: typeof p.command.args === "string" ? p.command.args : "" } : null;
        if (!command && (typeof p?.text !== "string" || !p.text.trim())) throw new RpcError("Nothing to send.");
        this.needIdle();
        this.turnStartedAt = Date.now();
        try {
          return (await this.exclusive(async (signal) => {
            let text = p.text;
            let model = typeof p.model === "string" ? p.model : undefined;
            if (command) {
              const expansion = await r.expandCommand(command.name, command.args, this.ui, signal);
              if (signal.aborted) throw new RpcError(`/${command.name} was cancelled.`);
              if (!expansion.ok) throw new RpcError(`/${command.name}: ${expansion.reason}`);
              text = expansion.prompt;
              model = expansion.model ?? model;
            }
            const display = p.display ?? (command ? `/${command.name}${command.args ? ` ${command.args}` : ""}` : text);
            this.broadcast({ t: "user", text: display }, origin);
            // The terminal's ↑ history includes what was sent from the browser.
            r.recordInput(display);
            r.setTurnModel(model);
            try {
              return await this.agent.run(text, signal);
            } finally {
              r.setTurnModel(undefined);
              this.turns++;
            }
          })) as RpcMap[M]["result"];
        } finally {
          this.turnStartedAt = undefined;
        }
      }
      case "expand": {
        const p = params as RpcMap["expand"]["params"];
        if (typeof p?.name !== "string") throw new RpcError("Which command?");
        return (await this.exclusive((signal) => r.expandCommand(p.name, typeof p.args === "string" ? p.args : "", this.ui, signal))) as RpcMap[M]["result"];
      }
      case "interrupt":
        this.controller?.abort();
        return null as RpcMap[M]["result"];
      case "setMode":
        if (!MODES.includes(params as Mode) || !r.modes.includes(params as Mode)) throw new RpcError("That mode isn't available.");
        r.setMode(params as Mode);
        this.broadcastState();
        return null as RpcMap[M]["result"];
      case "setModel":
        if (typeof params !== "string" || !params.trim()) throw new RpcError("Which model?");
        r.setModel(params.trim());
        this.broadcastState();
        return null as RpcMap[M]["result"];
      case "setEffort":
        if (!EFFORTS.includes(params as Effort)) throw new RpcError(`Effort must be one of: ${EFFORTS.join(", ")}.`);
        r.setEffort(params as Effort);
        this.broadcastState();
        return null as RpcMap[M]["result"];
      case "panel":
        if (!LIST_TOPICS.includes(params as ListTopic)) throw new RpcError("Unknown panel.");
        return (await r.panel(params as ListTopic)) as RpcMap[M]["result"];
      case "sessions":
        return (await r.sessions()).map((s) => ({
          id: s.id,
          title: s.title,
          updatedAt: new Date(s.updatedAt).toISOString(),
          messageCount: s.messageCount,
        })) as RpcMap[M]["result"];
      case "resume":
        if (typeof params !== "string") throw new RpcError("Which session?");
        // exclusive: these await slow work, and a prompt must not start on the agent being replaced.
        return (await this.exclusive(async () => {
          await r.resume(params);
          return this.resetAgent();
        })) as RpcMap[M]["result"];
      case "clear":
        return (await this.exclusive(async () => {
          await r.clear();
          return this.resetAgent();
        })) as RpcMap[M]["result"];
      case "undo":
        return (await this.exclusive(() => r.undo())) as RpcMap[M]["result"];
      case "redo":
        return (await this.exclusive(() => r.redo())) as RpcMap[M]["result"];
      case "learned.undo": {
        this.needIdle();
        if (params !== undefined && typeof params !== "string") throw new RpcError("Which change?");
        const out = await r.undoLearned(params as string | undefined);
        if (!out.ok) throw new RpcError(out.reason);
        return { summary: out.summary } as RpcMap[M]["result"];
      }
      case "providers.status":
        return (await r.providers.status()).map(
          (s): ProviderInfoView => ({
            id: s.info.id,
            name: s.info.name,
            keyRequired: s.info.keyRequired,
            keyURL: s.info.keyURL,
            keyEnv: s.info.keyEnv,
            noKeyNote: s.info.noKeyNote,
            // Where the key comes from, never the key.
            key: s.key ? (s.key.kind === "env" ? { kind: "env", name: s.key.name } : { kind: "saved" }) : null,
          }),
        ) as RpcMap[M]["result"];
      case "providers.connect": {
        const p = params as RpcMap["providers.connect"]["params"];
        if (typeof p?.id !== "string" || typeof p.key !== "string" || !p.key.trim()) throw new RpcError("A provider and a key are needed.");
        await r.providers.connect(p.id, p.key.trim());
        return null as RpcMap[M]["result"];
      }
      case "providers.disconnect":
        if (typeof params !== "string") throw new RpcError("Which provider?");
        return (await r.providers.disconnect(params)) as RpcMap[M]["result"];
      case "providers.models": {
        if (typeof params !== "string") throw new RpcError("Which provider?");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        try {
          return (await r.providers.models(params, controller.signal)) as RpcMap[M]["result"];
        } finally {
          clearTimeout(timer);
        }
      }
      case "modelPrefs.get":
        return (await r.modelPrefs.get()) as RpcMap[M]["result"];
      case "modelPrefs.recordUse":
        if (typeof params !== "string") throw new RpcError("Which model?");
        await r.modelPrefs.recordUse(params);
        return null as RpcMap[M]["result"];
      case "modelPrefs.toggleFavorite":
        if (typeof params !== "string") throw new RpcError("Which model?");
        return (await r.modelPrefs.toggleFavorite(params)) as RpcMap[M]["result"];
      case "completeFile": {
        const token = (params as RpcMap["completeFile"]["params"])?.token;
        if (typeof token !== "string" || !token.startsWith("@")) return [] as RpcMap[M]["result"];
        return (await completeFile(token, r.cwd)) as RpcMap[M]["result"];
      }
      case "project.select":
        // One session serves `tcode web`; the gateway's ProjectHosts answers this before it reaches a host.
        throw new RpcError("Switching projects needs the background service's dashboard (tcode dashboard).");
    }
    throw new RpcError("Unknown request.");
  }
}
