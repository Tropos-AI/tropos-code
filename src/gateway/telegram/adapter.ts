// src/gateway/telegram/adapter.ts — routes Telegram private chats to agent sessions.
import { isAbsolute, relative } from "node:path";
import type { AgentEvent, PermissionPrompt, TurnEndReason } from "../../agent/events";
import { AUTONOMY_LEVELS, type Autonomy } from "../config";
import { SenderNotApprovedError, UnknownCommandError, UserFacingError } from "../errors";
import type { SessionState } from "../../web/protocol";
import type { ChannelAdapter, ChatAutonomy, ChatProjects, ChatSession, ChatWorktrees, Pairing, SessionProvider, WorktreeSummary } from "../types";
import { OWNER_ONLY_FINISH } from "../worktrees";
import { OWNER_GREETING, candidateFrom, type OwnerClaimStore } from "../owner-claim";
import { findSecrets } from "../../tools/setup/secrets";
import { MAX_IMAGE_BYTES, MAX_IMAGES, sniffImage, type PromptAttachment } from "../../attachments/attachments";
import { TelegramError, type TelegramApi, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./api";
import {
  assistantText,
  BOT_COMMANDS,
  discardConfirmKeyboard,
  HELP_TEXT,
  learnedText,
  oneLine,
  parseCallbackData,
  parseProjectCallback,
  parseWorktreeCallback,
  permissionKeyboard,
  permissionView,
  projectKeyboard,
  projectListText,
  redactSecrets,
  renderToolBatch,
  splitMessage,
  statusText,
  turnEndNote,
  taskSummaryText,
  worktreeKeyboard,
  worktreeText,
  type ToolLine,
} from "./render";

const CHANNEL = "telegram";
const MAX_TOOL_LINES = 12;
/** Past this many per turn the summary only counts them. */
const MAX_RECORDED = 100;
const MAX_UNPAIRED_MEMORY = 1000;
/** How long start() waits for the bot's command list to be registered. */
const COMMANDS_WAIT_MS = 10_000;
const LEARNED_REFUSAL = "Only the owner can see what I've learned, in their private chat with me.";
const AUTONOMY_REFUSAL = "Only the owner can see or change the autonomy level.";
const AUTONOMY_USAGE = "Use /autonomy, /autonomy ask or /autonomy balanced.";
const LOGIN_REFUSAL = "Only the owner can log in a browser from here.";
const LOGIN_NO_OWNER = "Pick the owner first: Settings → Channels & devices on the dashboard.";
const NON_TEXT_REPLY_GAP_MS = 10_000;
const IMAGE_TOO_BIG = `That image is over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB. Send a smaller one.`;
const IMAGE_DOWNLOAD_FAILED = "I couldn't download that image from Telegram. Try sending it again.";

/** The reply to a file that is neither text nor an image (a voice note, a PDF …). */
export const NON_TEXT_REPLY = "I can read text and images, but not this kind of file yet.";
export const SECRET_REMOVED_NOTE = "I removed that message so the key doesn't stay in this chat. I'm holding it for this conversation only.";
export const CLAIM_REPLY = "Got it. Go back to the setup on your computer and confirm it's you.";

export interface TelegramAdapterOptions {
  api: TelegramApi;
  sessions: SessionProvider;
  pairing: Pairing;
  /** Lets chats see and switch their project (/project). Without it the command says it isn't available. */
  projects?: ChatProjects;
  /** Lets the owner see and lower the autonomy level (/autonomy). Without it the command says it isn't available. */
  autonomy?: ChatAutonomy;
  /** Lets the owner finish a chat's git-worktree task with buttons. Without it a turn ends without any. */
  worktrees?: ChatWorktrees;
  /** The text for /login: a fresh code and where to type it. Without it the command says it isn't available. */
  loginMessage?: () => Promise<string>;
  allowGroups?: boolean;
  /**
   * Set while `tcode setup` waits for the owner's first message: a stranger is then recorded, not given a pairing code,
   * and the owner picks them on the computer. Nobody is approved from here.
   */
  ownerClaim?: Pick<OwnerClaimStore, "isOpen" | "add"> & Partial<Pick<OwnerClaimStore, "isAuto" | "close">>;
  /** Unanswered permission requests are denied after this long. Default 5 minutes. */
  askTimeoutMs?: number;
  log?: (message: string) => void;
  /** Minimum gap between sends to one chat (Telegram allows about one message a second). Default 1000. */
  minIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  pollTimeoutSec?: number;
  /** How long the photos of an album are collected into one turn after the last arrived. Default 1500. */
  mediaGroupWaitMs?: number;
}

/** An image a message carries: a photo (its largest size that fits) or an image sent as a document. */
interface ImageRef {
  fileId: string;
  name: string;
  size?: number;
}

function imageOf(msg: TgMessage): ImageRef | null {
  if (msg.photo?.length) {
    const sizes = [...msg.photo].sort((a, b) => a.width * a.height - b.width * b.height);
    const largest = sizes.at(-1)!;
    // Telegram offers several sizes; the largest that fits the cap, or the largest (refused as too big).
    const pick = largest.file_size !== undefined && largest.file_size > MAX_IMAGE_BYTES ? (sizes.filter((s) => s.file_size !== undefined && s.file_size <= MAX_IMAGE_BYTES).at(-1) ?? largest) : largest;
    return { fileId: pick.file_id, name: "photo.jpg", ...(pick.file_size !== undefined ? { size: pick.file_size } : {}) };
  }
  if (msg.document?.mime_type?.startsWith("image/")) {
    const d = msg.document;
    return { fileId: d.file_id, name: d.file_name || "image", ...(d.file_size !== undefined ? { size: d.file_size } : {}) };
  }
  return null;
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

/** One thing waiting to run: a message (with any images it carried), or a `/name args` skill or command. */
type QueueItem = { text: string; attachments?: PromptAttachment[] } | { command: string; args: string };

interface Chat {
  chatId: number;
  senderId: string;
  session: ChatSession;
  detach: () => void;
  outbox: Outbox;
  queue: QueueItem[];
  running: boolean;
  /** Another client's turn is running on the session: hold the queue until it ends. */
  blocked: boolean;
  tools: ToolLine[];
  asks: Map<number, AskEntry>;
  errorSent: boolean;
  /** Learned notices that arrived during a turn: sent after its answer. */
  heldNotices: string[];
  /** This turn's finished edits and commands, for the summary after the answer. */
  done: { files: Set<string>; commands: string[]; moreFiles: number; moreCommands: number; pending: Map<string, { name: string; input: unknown }> };
  /** The chat's project folder, to show changed files relative to it. */
  root: string | undefined;
  /** The project this chat's session works in; when the agent switches it (SwitchProject), the session is left. */
  projectId: string | undefined;
  /** The first message of the task, for the commit and PR title. */
  taskTitle?: string;
  /** The message carrying the end-of-task buttons; `busy` while a button's action runs. */
  worktreeMsg?: { messageId: number; text: string; busy: boolean };
  /** What the buttons were drawn from, to draw them again after Cancel. */
  worktreeSummary?: WorktreeSummary;
}

/** `/Project@MyBot arg` -> `project`. */
function commandWord(text: string): string {
  return (text.split(/\s+/)[0] ?? "").slice(1).split("@")[0]?.toLowerCase() ?? "";
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
  private readonly projects: ChatProjects | undefined;
  private readonly autonomy: ChatAutonomy | undefined;
  private readonly worktrees: ChatWorktrees | undefined;
  private readonly loginMessage: (() => Promise<string>) | undefined;
  private readonly allowGroups: boolean;
  private readonly ownerClaim?: Pick<OwnerClaimStore, "isOpen" | "add"> & Partial<Pick<OwnerClaimStore, "isAuto" | "close">>;
  private readonly claimReplied = new Set<string>();
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
  /** Chat id -> when NON_TEXT_REPLY was last said there. */
  private readonly nonTextRepliedAt = new Map<number, number>();
  private readonly mediaGroupWaitMs: number;
  /** Albums being collected (`<chat id>:<media_group_id>`): their photos become one turn. */
  private readonly albums = new Map<string, { chat: Chat; text: string; attachments: PromptAttachment[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(opts: TelegramAdapterOptions) {
    this.api = opts.api;
    this.sessions = opts.sessions;
    this.pairing = opts.pairing;
    this.projects = opts.projects;
    this.autonomy = opts.autonomy;
    this.worktrees = opts.worktrees;
    this.loginMessage = opts.loginMessage;
    this.allowGroups = opts.allowGroups ?? false;
    this.ownerClaim = opts.ownerClaim;
    this.askTimeoutMs = opts.askTimeoutMs ?? 300_000;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 30;
    this.mediaGroupWaitMs = opts.mediaGroupWaitMs ?? 1500;
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
    this.loop = this.poll();
    // Awaited, so what starts after the channels finds the commands registered; a slow Telegram holds the start for
    // at most COMMANDS_WAIT_MS, and the registration carries on in the background.
    const registered = this.api.setMyCommands(BOT_COMMANDS).catch((e) => this.log("setMyCommands failed", e));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([registered, new Promise<void>((resolve) => (timer = setTimeout(resolve, COMMANDS_WAIT_MS)))]);
    clearTimeout(timer);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    await this.loop;
    this.loop = undefined;
    for (const album of this.albums.values()) clearTimeout(album.timer);
    this.albums.clear();
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

  /** Sends text to `telegram:<chat id>`, split to Telegram's message size. */
  async deliver(chatKey: string, text: string): Promise<void> {
    const id = /^telegram:(-?\d{1,20})$/.exec(chatKey)?.[1];
    if (id === undefined) throw new Error(`"${chatKey}" is not a Telegram chat`);
    const chatId = Number(id);
    const chat = this.chats.get(chatKey);
    for (const part of splitMessage(text)) {
      // Through the chat's outbox when it has one, so the send keeps its place in line and the rate limit.
      if (chat) {
        let failure: unknown;
        const sent = await chat.outbox.run(async () => {
          try {
            return (await this.api.sendMessage(chatId, part)).message_id;
          } catch (e) {
            failure = e;
            throw e;
          }
        });
        if (sent === undefined) throw failure instanceof Error ? failure : new Error("send failed");
      } else {
        await this.api.sendMessage(chatId, part);
      }
    }
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
    if (!msg.from || msg.from.is_bot) return;
    const senderId = String(msg.from.id);
    const approved = await this.pairing.isApproved(CHANNEL, senderId);
    if (!approved) {
      // A stranger's photo or file is not worth a pairing code.
      if (msg.text === undefined) return;
      if (await this.recordClaim(msg)) return;
      await this.handleStranger(msg.chat.id, senderId);
      return;
    }
    // Setup listens for the owner and there is none yet: someone approved earlier may be the one opening the link.
    if (msg.text !== undefined && (await this.recordClaim(msg, async () => (await this.pairing.owner()) === null))) return;
    if (msg.text === undefined) {
      const image = imageOf(msg);
      if (image) return this.handleImage(msg, senderId, image);
      // One reply per chat per 10 s (several files arrive as many messages), and none for a group's service messages.
      const now = Date.now();
      if (msg.chat.type !== "private" || now - (this.nonTextRepliedAt.get(msg.chat.id) ?? 0) < NON_TEXT_REPLY_GAP_MS) return;
      if (this.nonTextRepliedAt.size >= MAX_UNPAIRED_MEMORY) this.nonTextRepliedAt.clear();
      this.nonTextRepliedAt.set(msg.chat.id, now);
      await this.reply(msg.chat.id, NON_TEXT_REPLY);
      return;
    }
    const text = msg.text.trim();
    if (!text) return;
    if (findSecrets(text).length > 0) await this.removeSecretMessage(msg);
    // Before the session is opened: switching away from a project whose session can't start must still work.
    if (text.startsWith("/") && /^project(s)?$/.test(commandWord(text))) {
      await this.handleProjectCommand(msg.chat.id, text);
      return;
    }
    // Before the session is opened, and only for the owner in their private chat (a group would show it to everyone).
    if (text.startsWith("/") && commandWord(text) === "autonomy") {
      await this.handleAutonomyCommand(msg.chat.id, msg.chat.type, senderId, text);
      return;
    }
    // Before the session is opened, and only for the owner in their private chat: the code would reach a whole group.
    if (text.startsWith("/") && commandWord(text) === "login") {
      await this.handleLoginCommand(msg.chat.id, msg.chat.type, senderId);
      return;
    }
    // Before the session is opened: a guest's /learned, or the owner's in a group, is refused without starting one.
    if (text.startsWith("/") && commandWord(text) === "learned" && !(msg.chat.type === "private" && (await this.pairing.isOwner(CHANNEL, senderId)))) {
      await this.reply(msg.chat.id, LEARNED_REFUSAL);
      return;
    }
    const chat = await this.chatFor(msg.chat.id, senderId);
    if (!chat) return;
    if (text.startsWith("/")) {
      await this.handleCommand(chat, senderId, text);
      return;
    }
    this.enqueue(chat, { text });
  }

  /** A photo or image file from an approved sender: downloaded (same caps as the dashboard) and sent with its caption. */
  private async handleImage(msg: TgMessage, senderId: string, image: ImageRef): Promise<void> {
    const caption = (msg.caption ?? "").trim();
    if (caption && findSecrets(caption).length > 0) await this.removeSecretMessage(msg);
    let attachment: PromptAttachment;
    try {
      attachment = await this.downloadImage(image);
    } catch (e) {
      this.log("image download failed", e);
      await this.reply(msg.chat.id, e instanceof UserFacingError ? e.message : IMAGE_DOWNLOAD_FAILED);
      return;
    }
    const chat = await this.chatFor(msg.chat.id, senderId);
    if (!chat) return;
    if (!msg.media_group_id) return this.enqueue(chat, { text: caption, attachments: [attachment] });
    // An album arrives as one message per photo: collect them into one turn, sent once no more arrive.
    const key = `${msg.chat.id}:${msg.media_group_id}`;
    const album = this.albums.get(key) ?? { chat, text: "", attachments: [], timer: undefined as unknown as ReturnType<typeof setTimeout> };
    clearTimeout(album.timer);
    album.attachments.push(attachment);
    if (caption) album.text = album.text ? `${album.text}\n${caption}` : caption;
    const send = () => {
      if (this.albums.get(key) !== album) return;
      this.albums.delete(key);
      this.enqueue(album.chat, { text: album.text, attachments: album.attachments });
    };
    this.albums.set(key, album);
    if (album.attachments.length >= MAX_IMAGES) return send();
    album.timer = setTimeout(send, this.mediaGroupWaitMs);
  }

  /** Throws a UserFacingError for an image that is too big or isn't one; any other error is a failed download. */
  private async downloadImage(image: ImageRef): Promise<PromptAttachment> {
    if (image.size !== undefined && image.size > MAX_IMAGE_BYTES) throw new UserFacingError(IMAGE_TOO_BIG);
    const file = await this.api.getFile(image.fileId, this.abort.signal);
    if (file.size !== undefined && file.size > MAX_IMAGE_BYTES) throw new UserFacingError(IMAGE_TOO_BIG);
    let bytes: Uint8Array;
    try {
      bytes = await this.api.downloadFile(file.path, MAX_IMAGE_BYTES, this.abort.signal);
    } catch (e) {
      if (e instanceof TelegramError && e.status === 413) throw new UserFacingError(IMAGE_TOO_BIG);
      throw e;
    }
    const mediaType = sniffImage(bytes);
    if (!mediaType) throw new UserFacingError(`${image.name} isn't a PNG, JPEG, GIF or WebP image.`);
    return { name: image.name, mediaType, data: Buffer.from(bytes).toString("base64") };
  }

  /** Deletes the message that held a key and says so; the session still gets the text, and its host seals it. */
  private async removeSecretMessage(msg: TgMessage): Promise<void> {
    try {
      await this.api.deleteMessage(msg.chat.id, msg.message_id);
    } catch (e) {
      // The error names the method, never the text.
      this.log("deleting a message that held a key failed", e);
    }
    await this.reply(msg.chat.id, SECRET_REMOVED_NOTE);
  }

  /** True when setup is listening and this private message was recorded as a candidate (and answered once per sender). */
  /** `eligible` is asked only while the window is open (an approved sender counts only while there is no owner). */
  private async recordClaim(msg: TgMessage, eligible: () => Promise<boolean> = async () => true): Promise<boolean> {
    if (!this.ownerClaim || !(await this.ownerClaim.isOpen().catch(() => false))) return false;
    if (!(await eligible().catch(() => false))) return false;
    const candidate = candidateFrom(msg, Date.now());
    if (!candidate) return false;
    // The store refuses a message dated before the window began: that sender is just a stranger.
    const recorded = await this.ownerClaim.add(candidate, msg.text).catch((e) => (this.log("recording the owner candidate failed", e), false));
    if (!recorded) return false;
    // A window `tcode onboard` opened: the secret from the link is the proof, so whoever sent it becomes the owner now,
    // and nobody waits at the terminal. Only while there is no owner; a later claim never replaces one.
    if (await this.ownerClaim.isAuto?.().catch(() => false)) {
      try {
        if ((await this.pairing.owner()) === null) {
          await this.pairing.approveSender(CHANNEL, candidate.senderId);
          await this.pairing.setOwner(CHANNEL, candidate.senderId);
          await this.ownerClaim.close?.();
          await this.api.sendMessage(candidate.chatId, OWNER_GREETING).catch((e) => this.log("owner greeting failed", e));
          return true;
        }
      } catch (e) {
        this.log("making the owner failed", e);
      }
    }
    if (!this.claimReplied.has(candidate.senderId)) {
      if (this.claimReplied.size >= MAX_UNPAIRED_MEMORY) this.claimReplied.clear();
      this.claimReplied.add(candidate.senderId);
      await this.api.sendMessage(candidate.chatId, CLAIM_REPLY).catch((e) => this.log("claim reply failed", e));
    }
    return true;
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
      if (e instanceof SenderNotApprovedError) return undefined;
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
      heldNotices: [],
      done: { files: new Set(), commands: [], moreFiles: 0, moreCommands: 0, pending: new Map() },
      root: undefined,
      projectId: (await this.projects?.current(key).catch(() => undefined))?.id,
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
        if (event.name === "Bash" || event.name === "Edit" || event.name === "Write") chat.done.pending.set(event.id, { name: event.name, input: event.input });
        if (chat.tools.length >= MAX_TOOL_LINES) this.flushTools(chat);
        break;
      case "tool_end": {
        const line = chat.tools.find((l) => l.id === event.id);
        if (line) line.status = event.status;
        this.recordDone(chat, event.id, event.status);
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
        if (event.learned) {
          // During a turn it follows the answer; between turns (a review, a save elsewhere) it goes at once.
          if (chat.running || chat.session.state().busy) chat.heldNotices.push(event.text);
          else this.sendAll(chat, event.text);
        } else if (event.level === "error") {
          chat.errorSent = true;
          this.flushTools(chat);
          this.sendAll(chat, `Error: ${oneLine(event.text, 300)}`);
        }
        break;
      case "turn_end":
        this.flushTools(chat);
        this.flushSummary(chat);
        this.flushNotices(chat);
        chat.blocked = false;
        this.drain(chat);
        break;
      default:
        break;
    }
  }

  /** Only calls that finished count: a denied or failed one changed nothing. */
  private recordDone(chat: Chat, id: string, status: "done" | "error" | "denied"): void {
    const call = chat.done.pending.get(id);
    chat.done.pending.delete(id);
    if (!call || status !== "done" || typeof call.input !== "object" || call.input === null) return;
    const input = call.input as { command?: unknown; file_path?: unknown };
    if (call.name === "Bash" && typeof input.command === "string") {
      if (chat.done.commands.length < MAX_RECORDED) chat.done.commands.push(input.command);
      else chat.done.moreCommands++;
    } else if (typeof input.file_path === "string") {
      const rel = chat.root && isAbsolute(input.file_path) ? relative(chat.root, input.file_path) : input.file_path;
      const file = rel === ".." || rel.startsWith("../") ? input.file_path : rel;
      if (chat.done.files.has(file)) return;
      if (chat.done.files.size < MAX_RECORDED) chat.done.files.add(file);
      else chat.done.moreFiles++;
    }
  }

  private resetDone(chat: Chat): void {
    chat.done.files.clear();
    chat.done.commands.length = 0;
    chat.done.moreFiles = 0;
    chat.done.moreCommands = 0;
    chat.done.pending.clear();
  }

  /** Sent once per turn, after the answer and before any learned notices. */
  private flushSummary(chat: Chat): void {
    const text = taskSummaryText({ files: [...chat.done.files], commands: chat.done.commands, moreFiles: chat.done.moreFiles, moreCommands: chat.done.moreCommands });
    this.resetDone(chat);
    if (text) this.sendAll(chat, text);
  }

  private flushNotices(chat: Chat): void {
    const held = chat.heldNotices.splice(0);
    for (const text of held) this.sendAll(chat, text);
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
    const projectId = parseProjectCallback(cb.data);
    if (projectId !== undefined) {
      await this.handleProjectButton(cb, chatId, projectId);
      return;
    }
    const wtButton = parseWorktreeCallback(cb.data);
    if (wtButton !== undefined) {
      await this.handleWorktreeButton(cb, chatId, wtButton);
      return;
    }
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

  private async handleWorktreeButton(cb: TgCallbackQuery, chatId: number, action: NonNullable<ReturnType<typeof parseWorktreeCallback>>): Promise<void> {
    const key = `${CHANNEL}:${chatId}`;
    const chat = this.chats.get(key);
    const worktrees = this.worktrees;
    // Only the approved sender of that chat may press; anyone else is ignored without a reply.
    if (!worktrees || !chat || chat.senderId !== String(cb.from.id) || !(await this.pairing.isApproved(CHANNEL, chat.senderId))) return;
    const answer = (text: string) => this.api.answerCallbackQuery(cb.id, oneLine(text, 190)).catch((e) => this.log("callback answer failed", e));
    await chat.outbox.idle();
    const shown = chat.worktreeMsg;
    if (!shown || shown.messageId !== cb.message?.message_id) return void (await answer("These buttons are out of date."));
    if (shown.busy) return void (await answer("Working on it."));
    if (chat.running || chat.blocked || chat.queue.length > 0 || chat.session.state().busy) return void (await answer("Wait for the current turn to finish."));
    const edit = (text: string, replyMarkup: Parameters<TelegramApi["editMessageText"]>[3]) =>
      chat.outbox.run(() => this.api.editMessageText(chatId, shown.messageId, text, replyMarkup)).catch((e) => this.log("worktree edit failed", e));
    if (action === "discard") {
      await answer("Discard? Tap Yes to confirm.");
      await edit(`${shown.text}\nDiscard this branch and everything on it? This can't be undone.`, { replyMarkup: discardConfirmKeyboard() });
      return;
    }
    if (action === "cancel") {
      await answer("Cancelled.");
      if (chat.worktreeSummary) await edit(shown.text, { replyMarkup: worktreeKeyboard(chat.worktreeSummary) });
      return;
    }
    shown.busy = true;
    let result: string;
    try {
      result = await worktrees.finish(key, chat.senderId, action === "discard!" ? "discard" : action, chat.taskTitle ?? "");
    } catch (e) {
      shown.busy = false;
      this.log("worktree finish failed", e);
      await answer("That didn't work. Try again.");
      return;
    }
    await answer(result);
    if (result === OWNER_ONLY_FINISH) {
      shown.busy = false; // the buttons stay: keep and discard are still open to this sender
      return;
    }
    // The session is closed and the task is over: this message becomes the record, and the next message starts afresh.
    chat.worktreeMsg = undefined;
    await edit(`${shown.text}\n${result}`, { replyMarkup: { inline_keyboard: [] } });
    this.dropChat(chat);
  }

  // ---- prompts and commands ----

  private enqueue(chat: Chat, item: QueueItem): void {
    chat.queue.push(item);
    this.drain(chat);
  }

  private drain(chat: Chat): void {
    if (chat.running || chat.blocked || this.stopped) return;
    const next = chat.queue.shift();
    if (next === undefined) return;
    chat.running = true;
    void this.runTurn(chat, next);
  }

  private async runTurn(chat: Chat, item: QueueItem): Promise<void> {
    chat.errorSent = false;
    if ("text" in item && item.text) chat.taskTitle ??= oneLine(redactSecrets(item.text), 72);
    // Another client's turn may be in flight (busy): keep what it has recorded so far.
    if (!chat.session.state().busy) {
      this.resetDone(chat);
    }
    chat.root = (await this.projects?.current(`${CHANNEL}:${chat.chatId}`).catch(() => undefined))?.path;
    let reason: TurnEndReason | undefined;
    let busy = false;
    try {
      reason = "text" in item ? await chat.session.prompt(item.text, item.attachments) : await chat.session.command(item.command, item.args);
    } catch (e) {
      if (e instanceof Error && e.message === "busy") {
        // Another client's turn is running on this session: keep the text first in line until it ends.
        busy = true;
        chat.queue.unshift(item);
        chat.blocked = chat.session.state().busy;
      } else if (e instanceof SenderNotApprovedError) {
        // Revoked while this waited in the queue: nothing more of theirs runs, and nothing is said.
        chat.running = false;
        this.dropChat(chat);
        return;
      } else {
        this.log("prompt failed", e);
        const unknown = e instanceof UnknownCommandError;
        this.sendAll(chat, unknown ? `Unknown command.\n${HELP_TEXT}` : e instanceof UserFacingError ? e.message : "Something went wrong running that. Try again, or send /new.");
      }
    }
    chat.running = false;
    if (busy) {
      this.drain(chat);
      return;
    }
    this.flushTools(chat);
    // A turn that ended without a turn_end event (an error) still releases what it held.
    this.flushSummary(chat);
    this.flushNotices(chat);
    if (reason) {
      const note = turnEndNote(reason);
      if (note && !(reason === "error" && chat.errorSent)) this.sendAll(chat, note);
    }
    if (await this.projectMoved(chat)) return;
    if (reason === "end_turn") {
      // Held as running, so a message that arrives meanwhile waits until the buttons are out (they belong to this turn).
      chat.running = true;
      try {
        await this.offerWorktree(chat);
      } finally {
        chat.running = false;
      }
    }
    this.drain(chat);
  }

  /** After a turn that changed the task's worktree: the buttons to merge, open a PR, keep or discard. */
  private async offerWorktree(chat: Chat): Promise<void> {
    if (!this.worktrees || this.stopped) return;
    let summary: Awaited<ReturnType<ChatWorktrees["status"]>>;
    try {
      summary = await this.worktrees.status(`${CHANNEL}:${chat.chatId}`);
    } catch (e) {
      this.log("worktree status failed", e);
      return;
    }
    if (!summary || (summary.changedFiles === 0 && summary.commitsAhead === 0)) return;
    const previous = chat.worktreeMsg;
    if (previous) this.clearKeyboard(chat, previous.messageId, previous.text);
    const text = worktreeText(summary);
    chat.worktreeMsg = undefined;
    chat.worktreeSummary = summary;
    // Recorded inside the send, so a press that comes right after the message appears already finds it.
    await chat.outbox
      .run(async () => {
        const messageId = (await this.api.sendMessage(chat.chatId, text, { replyMarkup: worktreeKeyboard(summary) })).message_id;
        chat.worktreeMsg = { messageId, text, busy: false };
      })
      .catch((e) => this.log("worktree buttons failed", e));
  }

  /** Takes the buttons off a message (its text stays, or becomes `text`). */
  private clearKeyboard(chat: Chat, messageId: number, text: string): void {
    void chat.outbox.run(() => this.api.editMessageText(chat.chatId, messageId, text, { replyMarkup: { inline_keyboard: [] } })).catch((e) => this.log("worktree edit failed", e));
  }

  /**
   * The turn switched the chat's project (SwitchProject): this session is left (it stays resumable), and the next
   * message, or one already queued, opens the new project's session.
   */
  private async projectMoved(chat: Chat): Promise<boolean> {
    if (!this.projects || chat.projectId === undefined) return false;
    const now = (await this.projects.current(`${CHANNEL}:${chat.chatId}`).catch(() => undefined))?.id;
    if (now === undefined || now === chat.projectId || chat.running) return false;
    const queued = chat.queue.splice(0);
    this.dropChat(chat);
    if (queued.length === 0 || this.stopped) return true;
    const next = await this.chatFor(chat.chatId, chat.senderId);
    if (next) for (const item of queued) this.enqueue(next, item);
    return true;
  }

  /** Forgets the chat and what it queued; a later message that passes the approval check opens it afresh. */
  private dropChat(chat: Chat): void {
    const key = `${CHANNEL}:${chat.chatId}`;
    chat.queue.length = 0;
    for (const ask of chat.asks.values()) clearTimeout(ask.timer);
    chat.detach();
    if (this.chats.get(key) === chat) this.chats.delete(key);
    this.opening.delete(key);
  }

  private async currentProject(chat: Chat): Promise<{ id: string; name: string } | undefined> {
    return this.projects?.current(`${CHANNEL}:${chat.chatId}`).catch(() => undefined);
  }

  // ---- projects ----

  /** A reply outside any chat session (the session may be exactly what can't start). */
  private async reply(chatId: number, text: string, replyMarkup?: ReturnType<typeof projectKeyboard>): Promise<void> {
    for (const [i, part] of splitMessage(text).entries()) {
      await this.api.sendMessage(chatId, part, i === 0 && replyMarkup ? { replyMarkup } : {}).catch((e) => this.log("send failed", e));
    }
  }

  private async handleProjectCommand(chatId: number, text: string): Promise<void> {
    if (!this.projects) {
      await this.reply(chatId, "Projects aren't available here.");
      return;
    }
    const key = `${CHANNEL}:${chatId}`;
    const wanted = text.split(/\s+/)[1];
    try {
      if (wanted === undefined) {
        const [projects, current] = await Promise.all([this.projects.list(key), this.projects.current(key)]);
        await this.reply(chatId, projectListText(projects, current.id), projectKeyboard(projects, current.id));
        return;
      }
      await this.reply(chatId, await this.switchProject(chatId, wanted.toLowerCase()));
    } catch (e) {
      this.log("project command failed", e);
      await this.reply(chatId, e instanceof UserFacingError ? e.message : "Could not do that right now.");
    }
  }

  /** `/autonomy`, `/autonomy ask`, `/autonomy balanced`: owner only, private chat only, and only downwards. */
  private async handleLoginCommand(chatId: number, chatType: string, senderId: string): Promise<void> {
    if (chatType !== "private") {
      await this.reply(chatId, LOGIN_REFUSAL);
      return;
    }
    if (!(await this.pairing.owner())) {
      await this.reply(chatId, LOGIN_NO_OWNER);
      return;
    }
    if (!(await this.pairing.isOwner(CHANNEL, senderId))) {
      await this.reply(chatId, LOGIN_REFUSAL);
      return;
    }
    if (!this.loginMessage) {
      await this.reply(chatId, "Logging in a browser isn't available here.");
      return;
    }
    try {
      await this.reply(chatId, await this.loginMessage());
    } catch (e) {
      this.log("login code failed", e);
      await this.reply(chatId, "Could not make a login code. Try again.");
    }
  }

  private async handleAutonomyCommand(chatId: number, chatType: string, senderId: string, text: string): Promise<void> {
    if (chatType !== "private" || !(await this.pairing.isOwner(CHANNEL, senderId))) {
      await this.reply(chatId, AUTONOMY_REFUSAL);
      return;
    }
    if (!this.autonomy) {
      await this.reply(chatId, "Autonomy isn't available here.");
      return;
    }
    const args = text.split(/\s+/).slice(1);
    const wanted = args[0]?.toLowerCase();
    // "autonomous" is a valid level: it reaches lower(), which refuses the raise in one place.
    if (args.length > 1 || (wanted !== undefined && !AUTONOMY_LEVELS.includes(wanted as Autonomy))) {
      await this.reply(chatId, AUTONOMY_USAGE);
      return;
    }
    const key = `${CHANNEL}:${chatId}`;
    try {
      if (wanted === undefined) {
        const { level, project } = await this.autonomy.current(key);
        await this.reply(
          chatId,
          `Autonomy in ${oneLine(project.name, 60)}: ${level}.\nask: every edit and command asks · balanced: edits, read-only commands and tests run, the rest asks · autonomous: everything in the project runs, MCP tools ask.\nLower it with /autonomy ask or /autonomy balanced. Raising it is done on the computer: tcode config or the dashboard.`,
        );
        return;
      }
      const out = await this.autonomy.lower(key, wanted as Autonomy);
      await this.reply(chatId, `Autonomy in ${oneLine(out.project.name, 60)} ${out.changed ? "is now" : "is already"} ${out.level}.`);
    } catch (e) {
      this.log("autonomy command failed", e);
      await this.reply(chatId, e instanceof UserFacingError ? e.message : "Could not do that right now.");
    }
  }

  private async handleProjectButton(cb: TgCallbackQuery, chatId: number, projectId: string): Promise<void> {
    const senderId = String(cb.from.id);
    // Only an approved sender, and only in their own chat (a private chat's id is the sender's).
    if (!this.projects || !(await this.pairing.isApproved(CHANNEL, senderId))) return;
    if (!this.allowGroups && chatId !== cb.from.id) return;
    let note: string;
    try {
      note = await this.switchProject(chatId, projectId);
    } catch (e) {
      this.log("project switch failed", e);
      note = e instanceof UserFacingError ? e.message : "Could not switch right now.";
    }
    await this.api.answerCallbackQuery(cb.id, oneLine(note, 190)).catch((err) => this.log("callback answer failed", err));
    await this.reply(chatId, note);
  }

  /**
   * Points the chat at another project. The old project's session is left alone (it stays resumable and closes when
   * idle); the next message opens the new one. A turn in progress blocks the switch, since its questions and answer
   * would have nowhere to go.
   */
  private async switchProject(chatId: number, projectId: string): Promise<string> {
    const projects = this.projects!;
    const key = `${CHANNEL}:${chatId}`;
    const current = await projects.current(key);
    if (current.id === projectId) return `Already in ${current.name} (${current.id}).`;
    const open = this.chats.get(key);
    if (open && (open.running || open.queue.length > 0 || open.session.state().busy)) return "A turn is still running. Send /stop first, then switch.";
    const next = await projects.select(key, projectId);
    if (open) {
      for (const ask of open.asks.values()) clearTimeout(ask.timer);
      open.detach();
      this.chats.delete(key);
    }
    this.opening.delete(key);
    return `Switched to ${next.name} (${next.id}). Your next message continues there.`;
  }

  private async handleCommand(chat: Chat, senderId: string, text: string): Promise<void> {
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
        this.sendAll(chat, `${statusText(chat.session.state(), await this.currentProject(chat))}\nQueued: ${chat.queue.length}`);
        break;
      case "start":
        this.sendAll(chat, HELP_TEXT);
        break;
      case "learned":
        await this.handleLearned(chat, senderId, text.split(/\s+/)[1]?.toLowerCase());
        break;
      default: {
        // Anything else may be one of the user's skills or commands; the session knows.
        const args = text.replace(/^\S+\s*/, "").trim();
        this.enqueue(chat, { command, args });
      }
    }
  }

  /** `/learned` and `/learned undo`: what the agent saved on its own. Only the owner's chat may see or change it. */
  private async handleLearned(chat: Chat, senderId: string, arg: string | undefined): Promise<void> {
    // The owner check is in handleMessage; this re-check covers an owner change since. A private chat's id is its
    // sender's: anywhere else (a group) the owner's memory would be shown to everyone in it.
    if (String(chat.chatId) !== senderId || !(await this.pairing.isOwner(CHANNEL, senderId))) {
      this.sendAll(chat, LEARNED_REFUSAL);
      return;
    }
    try {
      if (arg === "undo") {
        const out = await chat.session.undoLearned();
        this.sendAll(chat, out.ok ? `Took back: ${out.summary}` : out.reason);
      } else {
        this.sendAll(chat, learnedText(await chat.session.learned()));
      }
    } catch (e) {
      this.log("learned failed", e);
      this.sendAll(chat, "Could not read that right now.");
    }
  }
}
