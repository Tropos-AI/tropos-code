// src/gateway/telegram/api.ts — a minimal Telegram Bot API client on global fetch.
import { z } from "zod";

const ChatSchema = z.object({ id: z.number(), type: z.string() });
const UserSchema = z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional() });
const MessageSchema = z.object({
  message_id: z.number(),
  chat: ChatSchema,
  from: UserSchema.optional(),
  text: z.string().optional(),
});
const CallbackQuerySchema = z.object({
  id: z.string(),
  from: UserSchema,
  message: z.object({ message_id: z.number(), chat: ChatSchema }).optional(),
  data: z.string().optional(),
});
const UpdateSchema = z.object({
  update_id: z.number(),
  message: MessageSchema.optional(),
  callback_query: CallbackQuerySchema.optional(),
});

export type TgMessage = z.infer<typeof MessageSchema>;
export type TgCallbackQuery = z.infer<typeof CallbackQuerySchema>;
export type TgUpdate = z.infer<typeof UpdateSchema>;

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface TelegramApiOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Waits between rate-limit retries; injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A failed Bot API call. The message never contains the bot token. */
export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

const Envelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TelegramApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: TelegramApiOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch);
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Removes the token (raw or URL-encoded) from any text. */
  redact(text: string): string {
    let out = text;
    for (const form of new Set([this.token, encodeURIComponent(this.token)])) {
      if (form) out = out.split(form).join("<token>");
    }
    return out;
  }

  async getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    const raw = await this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, signal);
    if (!Array.isArray(raw)) throw new TelegramError("getUpdates: unexpected response", 200, "unexpected response");
    const out: TgUpdate[] = [];
    for (const item of raw) {
      const full = UpdateSchema.safeParse(item);
      if (full.success) {
        out.push(full.data);
        continue;
      }
      // A malformed update is skipped, but its id still advances the offset.
      const id = z.object({ update_id: z.number() }).safeParse(item);
      if (id.success) out.push({ update_id: id.data.update_id });
    }
    return out;
  }

  async sendMessage(chatId: number | string, text: string, opts: { replyMarkup?: InlineKeyboard } = {}): Promise<TgMessage> {
    const raw = await this.call("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    });
    const parsed = MessageSchema.safeParse(raw);
    if (!parsed.success) throw new TelegramError("sendMessage: unexpected response", 200, "unexpected response");
    return parsed.data;
  }

  async editMessageText(chatId: number | string, messageId: number, text: string, opts: { replyMarkup?: InlineKeyboard } = {}): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      link_preview_options: { is_disabled: true },
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  private async call(method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new TelegramError(`${method} failed: ${this.redact(msg)}`, 0, this.redact(msg));
      }
      let envelope: z.infer<typeof Envelope> | undefined;
      try {
        const parsed = Envelope.safeParse(await res.json());
        if (parsed.success) envelope = parsed.data;
      } catch {
        // not JSON: handled below
      }
      if (envelope?.ok) return envelope.result;
      const status = envelope?.error_code ?? res.status;
      const description = this.redact(envelope?.description ?? res.statusText ?? "request failed");
      const retryAfter = envelope?.parameters?.retry_after;
      if (status === 429 && retryAfter !== undefined && attempt < MAX_RETRIES) {
        await this.sleep(Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS), signal);
        continue;
      }
      throw new TelegramError(`${method} failed (${status}): ${description}`, status, description, retryAfter);
    }
  }
}
