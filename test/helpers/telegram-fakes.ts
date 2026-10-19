// test/helpers/telegram-fakes.ts — in-memory fakes of the gateway contracts, for adapter tests.
import type { AgentEvent, PermissionAnswer, PermissionPrompt, TurnEndReason } from "../../src/agent/events";
import type { SessionState } from "../../src/web/protocol";
import type { PanelData } from "../../src/ui/runtime";
import type { ChatSession, ChatSink, Pairing, PairedSender, PairingChallenge, SessionProvider } from "../../src/gateway/types";

export function assistantEvent(text: string): AgentEvent {
  return { type: "assistant", message: { content: [{ type: "text", text }] } as never };
}

export class FakeSession implements ChatSession {
  readonly prompts: string[] = [];
  readonly commands: { name: string; args: string }[] = [];
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
  /** What a command does; the default echoes. Throw a UserFacingError to simulate an unknown command. */
  onCommand: (name: string, args: string, session: FakeSession) => Promise<TurnEndReason> = async (name, args, s) => {
    s.emit(assistantEvent(`ran /${name} ${args}`.trim()));
    s.emit({ type: "turn_end", reason: "end_turn" });
    return "end_turn";
  };
  /** What /learned shows, and what /learned undo answers. */
  learnedPanel: PanelData = { title: "Learned", sections: [], empty: "Nothing learned yet." };
  undoResult: { ok: true; summary: string } | { ok: false; reason: string } = { ok: false, reason: "Nothing to undo." };
  undos = 0;
  stateValue: SessionState = { model: "test-model", effort: "medium", mode: "default", busy: false, contextTokens: 0, totalCostUsd: 0.0123, turns: 2 } as SessionState;

  constructor(readonly key: string) {}

  async prompt(text: string): Promise<TurnEndReason> {
    this.prompts.push(text);
    return this.onPrompt(text, this);
  }
  async command(name: string, args: string): Promise<TurnEndReason> {
    this.commands.push({ name, args });
    return this.onCommand(name, args, this);
  }
  async learned(): Promise<PanelData> {
    return this.learnedPanel;
  }
  async undoLearned(): Promise<{ ok: true; summary: string } | { ok: false; reason: string }> {
    this.undos++;
    return this.undoResult;
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
  /** Owners as `<channel>:<senderId>`. */
  readonly owners = new Set<string>();

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
  async approveSender(channel: string, senderId: string): Promise<void> {
    this.approved.add(`${channel}:${senderId}`);
  }
  async list(): Promise<PairedSender[]> {
    return [];
  }
  async revoke(channel: string, senderId: string): Promise<boolean> {
    return this.approved.delete(`${channel}:${senderId}`);
  }
  async owner(): Promise<{ channel: string; senderId: string } | null> {
    const first = [...this.owners][0];
    if (!first) return null;
    const i = first.indexOf(":");
    return { channel: first.slice(0, i), senderId: first.slice(i + 1) };
  }
  async setOwner(channel: string, senderId: string): Promise<void> {
    this.owners.clear();
    this.owners.add(`${channel}:${senderId}`);
  }
  async isOwner(channel: string, senderId: string): Promise<boolean> {
    return this.owners.has(`${channel}:${senderId}`);
  }
}
