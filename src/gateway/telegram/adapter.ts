// src/gateway/telegram/adapter.ts — routes Telegram private chats to agent sessions.
import type { AgentEvent, PermissionPrompt, TurnEndReason } from "../../agent/events";
import { UserFacingError } from "../errors";
import type { SessionState } from "../../web/protocol";
import type { ChannelAdapter, ChatSession, Pairing, SessionProvider } from "../types";
import type { TelegramApi, TgCallbackQuery, TgMessage, TgUpdate } from "./api";
import {
  assistantText,
  BOT_COMMANDS,
  HELP_TEXT,
  oneLine,
  parseCallbackData,
  permissionKeyboard,
  permissionView,
  renderToolBatch,
  splitMessage,
  statusText,
  turnEndNote,
  type ToolLine,
} from "./render";

const CHANNEL = "telegram";
const MAX_TOOL_LINES = 12;
const MAX_UNPAIRED_MEMORY = 1000;

export interface TelegramAdapterOptions {
  api: TelegramApi;
  sessions: SessionProvider;
  pairing: Pairing;
  allowGroups?: boolean;
  /** Unanswered permission requests are denied after this long. Default 5 minutes. */
  askTimeoutMs?: number;
  log?: (message: string) => void;
  /** Minimum gap between sends to one chat (Telegram allows about one message a second). Default 1000. */
  minIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  pollTimeoutSec?: number;
}

interface AskEntry {
  header: string;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  sent: Promise<number | undefined>;
}

/** Serialises a chat's sends and edits and spaces them out. */
class Outbox {
  private tail: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(private readonly minIntervalMs: number) {}

  run<T>(op: () => Promise<T>): Promise<T | undefined> {
    const next = this.tail.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await op();
      } finally {
        this.last = Date.now();
      }
    });
    this.tail = next.catch(() => {});
    return next.catch(() => undefined);
  }

  idle(): Promise<unknown> {
    return this.tail;
  }
}

interface Chat {
  chatId: number;
  senderId: string;
  session: ChatSession;
  detach: () => void;
  outbox: Outbox;
  queue: string[];
  running: boolean;
  /** Another client's turn is running on the session: hold the queue until it ends. */
  blocked: boolean;
  tools: ToolLine[];
  asks: Map<number, AskEntry>;
  errorSent: boolean;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = CHANNEL;
  private readonly api: TelegramApi;
  private readonly sessions: SessionProvider;
  private readonly pairing: Pairing;
  private readonly allowGroups: boolean;
  private readonly askTimeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly pollTimeoutSec: number;
  private readonly logFn: (m: string) => void;

  private abort = new AbortController();
  private loop: Promise<void> | undefined;
  private stopped = false;
  private offset = 0;
  private readonly chats = new Map<string, Chat>();
  private readonly opening = new Map<string, Promise<Chat | undefined>>();
  /** Sender id -> pairing code already shown, so a code is sent once. */
  private readonly notified = new Map<string, string>();

  constructor(opts: TelegramAdapterOptions) {
    this.api = opts.api;
    this.sessions = opts.sessions;
    this.pairing = opts.pairing;
    this.allowGroups = opts.allowGroups ?? false;
    this.askTimeoutMs = opts.askTimeoutMs ?? 300_000;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 30;
    this.logFn = opts.log ?? (() => {});
  }

  private log(message: string, e?: unknown): void {
    const detail = e instanceof Error ? `: ${e.message}` : e === undefined ? "" : `: ${String(e)}`;
    this.logFn(this.api.redact(`telegram: ${message}${detail}`));
  }

  async start(): Promise<void> {
    if (this.loop) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.api.setMyCommands(BOT_COMMANDS).catch((e) => this.log("setMyCommands failed", e));
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    await this.loop;
    this.loop = undefined;
    for (const chat of this.chats.values()) {
      for (const [id, ask] of chat.asks) {
        if (ask.settled) continue;
        ask.settled = true;
        clearTimeout(ask.timer);
        chat.session.answer(id, { kind: "deny", message: "The Telegram gateway stopped." });
      }
      chat.detach();
    }
    this.chats.clear();
    this.opening.clear();
  }

  private async poll(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const updates = await this.api.getUpdates(this.offset, this.pollTimeoutSec, this.abort.signal);
        failures = 0;
        for (const update of updates) {
          if (this.stopped) break;
          this.offset = Math.max(this.offset, update.update_id + 1);
          try {
            await this.handleUpdate(update);
          } catch (e) {
            this.log("update handler failed", e);
          }
        }
      } catch (e) {
        if (this.stopped) break;
        failures++;
        this.log("polling failed", e);
        await sleepAbortable(Math.min(this.backoffBaseMs * 2 ** (failures - 1), this.backoffMaxMs), this.abort.signal);
      }
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.message) await this.handleMessage(update.message);
    else if (update.callback_query) await this.handleCallback(update.callback_query);
  }

  private async handleMessage(msg: TgMessage): Promise<void> {
    if (msg.chat.type !== "private" && !this.allowGroups) return;
    if (!msg.from || msg.from.is_bot || msg.text === undefined) return;
    const senderId = String(msg.from.id);
    if (!(await this.pairing.isApproved(CHANNEL, senderId))) {
      await this.handleStranger(msg.chat.id, senderId);
      return;
    }
    const chat = await this.chatFor(msg.chat.id, senderId);
    if (!chat) return;
    const text = msg.text.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      await this.handleCommand(chat, text);
      return;
    }
    this.enqueue(chat, text);
  }

  private async handleStranger(chatId: number, senderId: string): Promise<void> {
    const challenge = await this.pairing.challenge(CHANNEL, senderId);
    if (challenge.kind === "limited") return;
    if (this.notified.get(senderId) === challenge.code) return;
    if (this.notified.size >= MAX_UNPAIRED_MEMORY) this.notified.clear();
    this.notified.set(senderId, challenge.code);
    await this.api
      .sendMessage(
        chatId,
        `This bot is private. To get access, ask its owner to run:\n\ntcode pairing approve telegram ${challenge.code}\n\nYour pairing code is ${challenge.code}.`,
      )
      .catch((e) => this.log("pairing reply failed", e));
  }

  private chatFor(chatId: number, senderId: string): Promise<Chat | undefined> {
    const key = `${CHANNEL}:${chatId}`;
    const existing = this.chats.get(key);
    if (existing) return Promise.resolve(existing);
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.openChat(key, chatId, senderId).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  private async openChat(key: string, chatId: number, senderId: string): Promise<Chat | undefined> {
    let session: ChatSession;
    try {
      session = await this.sessions.open(key);
    } catch (e) {
      this.log(`could not open session ${key}`, e);
      await this.api.sendMessage(chatId, e instanceof UserFacingError ? e.message : "Could not start a session right now.").catch(() => {});
      return undefined;
    }
    const chat: Chat = {
      chatId,
      senderId,
      session,
      detach: () => {},
      outbox: new Outbox(this.minIntervalMs),
      queue: [],
      running: false,
      blocked: false,
      tools: [],
      asks: new Map(),
      errorSent: false,
    };
    chat.detach = session.attach({
      event: (event) => this.onEvent(chat, event),
      ask: (id, prompt) => this.onAsk(chat, id, prompt),
      askClosed: (id) => this.settleAsk(chat, id, "Closed: answered elsewhere or cancelled.", false),
      state: (state: SessionState) => {
        if (state.busy) return;
        chat.blocked = false;
        this.drain(chat);
      },
    });
    this.chats.set(key, chat);
    return chat;
  }

  // ---- outgoing ----

  private send(chat: Chat, text: string): Promise<number | undefined> {
    return chat.outbox.run(async () => (await this.api.sendMessage(chat.chatId, text)).message_id).then((id) => id);
  }

  private sendAll(chat: Chat, text: string): void {
    for (const part of splitMessage(text)) void this.sendLogged(chat, part);
  }

  private sendLogged(chat: Chat, text: string): Promise<number | undefined> {
    return chat.outbox
      .run(async () => (await this.api.sendMessage(chat.chatId, text)).message_id)
      .catch((e) => {
        this.log("send failed", e);
        return undefined;
      });
  }

  private flushTools(chat: Chat): void {
    if (chat.tools.length === 0) return;
    const text = renderToolBatch(chat.tools);
    chat.tools = [];
    this.sendAll(chat, text);
  }

  private onEvent(chat: Chat, event: AgentEvent): void {
    switch (event.type) {
      case "tool_start":
        chat.tools.push({ id: event.id, name: event.name, summary: event.summary });
        if (chat.tools.length >= MAX_TOOL_LINES) this.flushTools(chat);
        break;
      case "tool_end": {
        const line = chat.tools.find((l) => l.id === event.id);
        if (line) line.status = event.status;
        break;
      }
      case "assistant": {
        const text = assistantText(event.message);
        if (text) {
          this.flushTools(chat);
          this.sendAll(chat, text);
        }
        break;
      }
      case "notice":
        if (event.level === "error") {
          chat.errorSent = true;
          this.flushTools(chat);
          this.sendAll(chat, `Error: ${oneLine(event.text, 300)}`);
        }
        break;
      case "turn_end":
        this.flushTools(chat);
        chat.blocked = false;
        this.drain(chat);
        break;
      default:
        break;
    }
  }

  // ---- permission asks ----

  private onAsk(chat: Chat, id: number, prompt: PermissionPrompt): void {
    this.flushTools(chat);
    const { text: header, complete } = permissionView(prompt);
    if (!complete) {
      // Part of it is cut off, and a button would approve the part you can't see: deny, and say why.
      chat.session.answer(id, { kind: "deny", message: "Too long to review in Telegram; review it on the computer." });
      void chat.outbox
        .run(() => this.api.sendMessage(chat.chatId, `${header}\n\nToo long to review here, so I denied it. Ask for something smaller, or review it on the computer.`))
        .catch((e) => this.log("ask send failed", e));
      return;
    }
    const sent = chat.outbox
      .run(async () => (await this.api.sendMessage(chat.chatId, header, { replyMarkup: permissionKeyboard(id) })).message_id)
      .catch((e) => {
        this.log("ask send failed", e);
        return undefined;
      });
    const timer = setTimeout(() => this.settleAsk(chat, id, "Timed out: denied.", true), this.askTimeoutMs);
    chat.asks.set(id, { header, settled: false, timer, sent });
  }

  /** Marks an ask finished, optionally denying it, and edits its message to show the outcome. */
  private settleAsk(chat: Chat, id: number, outcome: string, deny: boolean, answer?: "allow" | "deny"): void {
    const ask = chat.asks.get(id);
    if (!ask || ask.settled) return;
    ask.settled = true;
    clearTimeout(ask.timer);
    if (deny) chat.session.answer(id, { kind: "deny", message: "No answer from Telegram in time." });
    else if (answer === "allow") chat.session.answer(id, { kind: "allow" });
    else if (answer === "deny") chat.session.answer(id, { kind: "deny", message: "Denied from Telegram." });
    void chat.outbox
      .run(async () => {
        const messageId = await ask.sent;
        if (messageId === undefined) return;
        await this.api.editMessageText(chat.chatId, messageId, `${ask.header}\n\n${outcome}`, { replyMarkup: { inline_keyboard: [] } });
      })
      .catch((e) => this.log("ask edit failed", e));
  }

  private async handleCallback(cb: TgCallbackQuery): Promise<void> {
    const chatId = cb.message?.chat.id;
    if (chatId === undefined) return;
    const chat = this.chats.get(`${CHANNEL}:${chatId}`);
    // Only the approved sender of that chat may answer; anyone else is ignored without a reply.
    if (!chat || chat.senderId !== String(cb.from.id) || !(await this.pairing.isApproved(CHANNEL, chat.senderId))) return;
    const parsed = parseCallbackData(cb.data);
    const ask = parsed ? chat.asks.get(parsed.id) : undefined;
    if (!parsed || !ask || ask.settled) {
      await this.api.answerCallbackQuery(cb.id, parsed ? "Already handled." : undefined).catch((e) => this.log("callback answer failed", e));
      return;
    }
    this.settleAsk(chat, parsed.id, parsed.approve ? "Approved." : "Denied.", false, parsed.approve ? "allow" : "deny");
    await this.api.answerCallbackQuery(cb.id, parsed.approve ? "Approved" : "Denied").catch((e) => this.log("callback answer failed", e));
  }

  // ---- prompts and commands ----

  private enqueue(chat: Chat, text: string): void {
    chat.queue.push(text);
    this.drain(chat);
  }

  private drain(chat: Chat): void {
    if (chat.running || chat.blocked || this.stopped) return;
    const next = chat.queue.shift();
    if (next === undefined) return;
    chat.running = true;
    void this.runTurn(chat, next);
  }

  private async runTurn(chat: Chat, text: string): Promise<void> {
    chat.errorSent = false;
    let reason: TurnEndReason | undefined;
    let busy = false;
    try {
      reason = await chat.session.prompt(text);
    } catch (e) {
      if (e instanceof Error && e.message === "busy") {
        // Another client's turn is running on this session: keep the text first in line until it ends.
        busy = true;
        chat.queue.unshift(text);
        chat.blocked = chat.session.state().busy;
      } else {
        this.log("prompt failed", e);
        this.sendAll(chat, "Something went wrong running that. Try again, or send /new.");
      }
    }
    chat.running = false;
    if (busy) {
      this.drain(chat);
      return;
    }
    this.flushTools(chat);
    if (reason) {
      const note = turnEndNote(reason);
      if (note && !(reason === "error" && chat.errorSent)) this.sendAll(chat, note);
    }
    this.drain(chat);
  }

  private async handleCommand(chat: Chat, text: string): Promise<void> {
    const command = (text.split(/\s+/)[0] ?? "").slice(1).split("@")[0]?.toLowerCase();
    switch (command) {
      case "stop":
        chat.queue.length = 0;
        chat.session.interrupt();
        break;
      case "new":
        chat.queue.length = 0;
        chat.session.interrupt();
        try {
          await chat.session.clear();
          this.sendAll(chat, "Started a new session.");
        } catch (e) {
          this.log("clear failed", e);
          this.sendAll(chat, "Could not start a new session.");
        }
        break;
      case "status":
        this.sendAll(chat, `${statusText(chat.session.state())}\nQueued: ${chat.queue.length}`);
        break;
      case "start":
        this.sendAll(chat, HELP_TEXT);
        break;
      default:
        this.sendAll(chat, `Unknown command.\n${HELP_TEXT}`);
    }
  }
}
