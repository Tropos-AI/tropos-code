// src/gateway/types.ts — the contracts between the gateway's parts. Type-only: no runtime imports.
import type { AgentEvent, PermissionAnswer, PermissionPrompt, TurnEndReason } from "../agent/events";
import type { SessionState } from "../web/protocol";
import type { GatewayConfig } from "./config";
import type { Project, ProjectSource } from "./projects";

/** What a channel adapter receives from one chat's session. */
export interface ChatSink {
  event(event: AgentEvent): void;
  /** The agent needs an answer; reply with `ChatSession.answer(id, …)`. */
  ask(id: number, prompt: PermissionPrompt): void;
  /** The question was answered (by someone else) or abandoned. */
  askClosed(id: number): void;
  state(state: SessionState): void;
}

/** One chat's conversation with the agent, as a channel sees it. */
export interface ChatSession {
  readonly key: string;
  /** Runs one turn. Rejects with an Error whose message is "busy" while another turn runs. */
  prompt(text: string): Promise<TurnEndReason>;
  /** Stops the running turn, if any. */
  interrupt(): void;
  /** Starts a fresh session for this chat. */
  clear(): Promise<void>;
  state(): SessionState;
  answer(id: number, answer: PermissionAnswer): void;
  /** Starts receiving events; returns the detach function. */
  attach(sink: ChatSink): () => void;
}

/** Opens (or reopens) the session behind a chat key such as `telegram:12345`. */
export interface SessionProvider {
  open(key: string): Promise<ChatSession>;
  close(key: string): Promise<void>;
}

export type PairingChallenge = { kind: "code"; code: string; expiresAt: number } | { kind: "limited" };

export interface PairedSender {
  channel: string;
  senderId: string;
  approvedAt: number;
}

/** Deny-by-default allowlist of the people who may talk to the agent through a channel. */
export interface Pairing {
  isApproved(channel: string, senderId: string): Promise<boolean>;
  /** For an unknown sender: the code to show them (the same one while it is valid), or `limited` after too many requests. */
  challenge(channel: string, senderId: string): Promise<PairingChallenge>;
  /** The owner approves a code on the machine. */
  approve(channel: string, code: string): Promise<{ ok: true; senderId: string } | { ok: false; reason: string }>;
  list(): Promise<PairedSender[]>;
  revoke(channel: string, senderId: string): Promise<boolean>;
}

/** A channel adapter: connects to a messaging service and routes its chats to sessions. */
export interface ChannelAdapter {
  readonly name: string;
  start(): Promise<void>;
  /** Stops polling and releases connections; idempotent. */
  stop(): Promise<void>;
  /** Sends text to a chat of this channel (`chatKey` is `<name>:<id>`), e.g. a scheduled job's result. */
  deliver?(chatKey: string, text: string): Promise<void>;
}

/** What a channel needs to show and change the project a chat is working in. */
export interface ChatProjects {
  current(chatKey: string): Promise<Project>;
  list(): Promise<Project[]>;
  /** Rejects with a user-facing error when the project doesn't exist. */
  select(chatKey: string, projectId: string): Promise<Project>;
}

/** What a background service (the scheduler, say) gets from the gateway when it starts. */
export interface GatewayServiceDeps {
  home: string;
  config: GatewayConfig;
  projects: ProjectSource;
  /**
   * A session to run something in. A chat key (`telegram:123`) is that chat's session in its current project; a
   * project id (`my-app`) is a session of its own in that project, which the caller may `clear()` for a fresh start.
   */
  openSession(target: string): Promise<ChatSession>;
  /** Sends text to a chat key through the channel that owns it; rejects when no channel can. */
  deliver(target: string, text: string): Promise<void>;
}

/** A long-running part of the gateway besides the channels. Started after the adapters, stopped before they are. */
export interface GatewayService {
  readonly name: string;
  start(deps: GatewayServiceDeps): Promise<void>;
  stop(): Promise<void>;
}
