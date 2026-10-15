// test/helpers/telegram-fakes.ts — in-memory fakes of the gateway contracts, for adapter tests.
import type { AgentEvent, PermissionAnswer, PermissionPrompt, TurnEndReason } from "../../src/agent/events";
import type { SessionState } from "../../src/web/protocol";
import type { ChatSession, ChatSink, Pairing, PairedSender, PairingChallenge, SessionProvider } from "../../src/gateway/types";

export function assistantEvent(text: string): AgentEvent {
  return { type: "assistant", message: { content: [{ type: "text", text }] } as never };
}

export class FakeSession implements ChatSession {
  readonly prompts: string[] = [];
  readonly answers: { id: number; answer: PermissionAnswer }[] = [];
  interrupted = 0;
  cleared = 0;
  busy = false;
  private readonly sinks = new Set<ChatSink>();
  /** What a prompt does; the default echoes. Throw Error("busy") to simulate another turn running. */
  onPrompt: (text: string, session: FakeSession) => Promise<TurnEndReason> = async (text, s) => {
    s.emit(assistantEvent(`echo: ${text}`));
    s.emit({ type: "turn_end", reason: "end_turn" });
    return "end_turn";
  };
  stateValue: SessionState = { model: "test-model", effort: "medium", mode: "default", busy: false, contextTokens: 0, totalCostUsd: 0.0123, turns: 2 } as SessionState;

  constructor(readonly key: string) {}

  async prompt(text: string): Promise<TurnEndReason> {
    this.prompts.push(text);
    return this.onPrompt(text, this);
  }
  interrupt(): void {
    this.interrupted++;
  }
  async clear(): Promise<void> {
    this.cleared++;
  }
  state(): SessionState {
    return { ...this.stateValue, busy: this.busy };
  }
  answer(id: number, answer: PermissionAnswer): void {
    this.answers.push({ id, answer });
  }
  attach(sink: ChatSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }
  get attached(): number {
    return this.sinks.size;
  }
  emit(event: AgentEvent): void {
    for (const s of this.sinks) s.event(event);
  }
  ask(id: number, prompt: PermissionPrompt): void {
    for (const s of this.sinks) s.ask(id, prompt);
  }
  askClosed(id: number): void {
    for (const s of this.sinks) s.askClosed(id);
  }
  pushState(): void {
    for (const s of this.sinks) s.state(this.state());
  }
}

export class FakeSessions implements SessionProvider {
  readonly sessions = new Map<string, FakeSession>();
  opens = 0;
  async open(key: string): Promise<ChatSession> {
    this.opens++;
    let s = this.sessions.get(key);
    if (!s) this.sessions.set(key, (s = new FakeSession(key)));
    return s;
  }
  async close(key: string): Promise<void> {
    this.sessions.delete(key);
  }
}

export class FakePairing implements Pairing {
  readonly approved = new Set<string>();
  readonly limited = new Set<string>();
  readonly challenges: string[] = [];
  readonly code = "ABCD2345";

  isApproved(channel: string, senderId: string): Promise<boolean> {
    return Promise.resolve(this.approved.has(`${channel}:${senderId}`));
  }
  challenge(channel: string, senderId: string): Promise<PairingChallenge> {
    this.challenges.push(senderId);
    if (this.limited.has(senderId)) return Promise.resolve({ kind: "limited" });
    return Promise.resolve({ kind: "code", code: this.code, expiresAt: Date.now() + 3_600_000 });
  }
  async approve(channel: string, code: string): Promise<{ ok: true; senderId: string } | { ok: false; reason: string }> {
    return code === this.code ? { ok: true, senderId: "?" } : { ok: false, reason: "bad code" };
  }
  async list(): Promise<PairedSender[]> {
    return [];
  }
  async revoke(channel: string, senderId: string): Promise<boolean> {
    return this.approved.delete(`${channel}:${senderId}`);
  }
}
