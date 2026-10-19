// test/helpers/telegram-fake-server.ts — an in-process fake of the Telegram Bot API, for tests.
import type { InlineKeyboard } from "../../src/gateway/telegram/api";

export interface SentMessage {
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup?: InlineKeyboard;
  /** Every later edit, oldest first. */
  edits: { text: string; replyMarkup?: InlineKeyboard }[];
}

interface Waiter {
  offset: number;
  resolve: (updates: unknown[]) => void;
}

export class FakeTelegramServer {
  readonly token = "123456:SECRET-fake-token";
  readonly sent: SentMessage[] = [];
  readonly answered: { id: string; text?: string }[] = [];
  /** Every deleteMessage call. */
  readonly deleted: { chatId: number; messageId: number }[] = [];
  readonly getUpdatesOffsets: number[] = [];
  commands: { command: string; description: string }[] = [];
  /** The next N getUpdates calls fail with HTTP 500. */
  failGetUpdates = 0;
  /** The next sendMessage answers 429 with this retry_after. */
  rateLimitNextSend: number | undefined;

  private readonly server: ReturnType<typeof Bun.serve>;
  private updates: Record<string, unknown>[] = [];
  private nextUpdateId = 100;
  private nextMessageId = 1;
  private waiters = new Set<Waiter>();

  constructor() {
    // On 127.0.0.1, where baseUrl points. Without a hostname Bun listens on every address (IPv6 `*`), and on macOS a
    // listener bound to 127.0.0.1 alone can take the same port number and answer this server's requests instead.
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    for (const w of this.waiters) w.resolve([]);
    this.server.stop(true);
  }

  /** True once the adapter has acknowledged (polled past) every update pushed so far: each one was handled. */
  allHandled(): boolean {
    return this.getUpdatesOffsets.some((o) => o >= this.nextUpdateId);
  }

  pushMessage(chatId: number, fromId: number, text: string, opts: { chatType?: string; from?: { first_name?: string; last_name?: string; username?: string }; date?: number } = {}): void {
    this.push({ message: { message_id: this.nextMessageId++ + 5000, chat: { id: chatId, type: opts.chatType ?? "private" }, from: { id: fromId, first_name: "T", ...opts.from }, text, date: opts.date ?? Math.floor(Date.now() / 1000) } });
  }

  /** A message without text (a photo, a voice note or a file), as Telegram sends it. */
  pushNonText(chatId: number, fromId: number, field: "photo" | "voice" | "document"): void {
    const media = field === "photo" ? [{ file_id: "p", width: 1, height: 1 }] : { file_id: "f" };
    this.push({ message: { message_id: this.nextMessageId++ + 5000, chat: { id: chatId, type: "private" }, from: { id: fromId, first_name: "T" }, [field]: media, date: 1 } });
  }

  /** Files that getFile and the download URL serve, by file_id. `reportedSize` is what getFile claims (default: the real size). */
  readonly files = new Map<string, { path: string; bytes: Uint8Array; reportedSize?: number }>();
  /** Every file download, by path. */
  readonly downloads: string[] = [];

  addFile(fileId: string, bytes: Uint8Array, reportedSize?: number): void {
    this.files.set(fileId, { path: `photos/${fileId}.bin`, bytes, reportedSize });
  }

  /** A photo as Telegram sends it: several sizes, smallest first; the last is `fileId`. */
  pushPhoto(chatId: number, fromId: number, opts: { fileId: string; caption?: string; mediaGroupId?: string; fileSize?: number }): void {
    const photo = [
      { file_id: `${opts.fileId}-thumb`, width: 90, height: 60 },
      { file_id: opts.fileId, width: 1280, height: 853, ...(opts.fileSize !== undefined ? { file_size: opts.fileSize } : {}) },
    ];
    this.push({
      message: {
        message_id: this.nextMessageId++ + 5000,
        chat: { id: chatId, type: "private" },
        from: { id: fromId, first_name: "T" },
        photo,
        ...(opts.caption !== undefined ? { caption: opts.caption } : {}),
        ...(opts.mediaGroupId ? { media_group_id: opts.mediaGroupId } : {}),
        date: 1,
      },
    });
  }

  /** A file sent as a document (uncompressed). */
  pushDocument(chatId: number, fromId: number, opts: { fileId: string; fileName?: string; mimeType?: string; caption?: string }): void {
    const document = { file_id: opts.fileId, ...(opts.fileName ? { file_name: opts.fileName } : {}), ...(opts.mimeType ? { mime_type: opts.mimeType } : {}) };
    this.push({
      message: { message_id: this.nextMessageId++ + 5000, chat: { id: chatId, type: "private" }, from: { id: fromId, first_name: "T" }, document, ...(opts.caption !== undefined ? { caption: opts.caption } : {}), date: 1 },
    });
  }

  pushCallback(fromId: number, chatId: number, messageId: number, data: string): void {
    this.push({ callback_query: { id: `cb${this.nextUpdateId}`, from: { id: fromId, first_name: "T" }, message: { message_id: messageId, chat: { id: chatId, type: "private" } }, data } });
  }

  /** Resolves when `check` holds, polling; rejects after `timeoutMs`. */
  async waitFor<T>(check: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() > end) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  textsTo(chatId: number): string[] {
    return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  }

  private push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update });
    this.flush();
  }

  private flush(): void {
    for (const w of [...this.waiters]) {
      const ready = this.updates.filter((u) => (u.update_id as number) >= w.offset);
      if (ready.length > 0) {
        this.waiters.delete(w);
        w.resolve(ready);
      }
    }
  }

  private json(result: unknown): Response {
    return Response.json({ ok: true, result });
  }

  private async handle(req: Request): Promise<Response> {
    const download = /^\/file\/bot([^/]+)\/(.+)$/.exec(new URL(req.url).pathname);
    if (download) {
      if (decodeURIComponent(download[1] as string) !== this.token) return new Response("Unauthorized", { status: 401 });
      const path = decodeURIComponent(download[2] as string);
      this.downloads.push(path);
      const file = [...this.files.values()].find((f) => f.path === path);
      return file ? new Response(new Blob([file.bytes as Uint8Array<ArrayBuffer>])) : new Response("Not Found", { status: 404 });
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname);
    if (!m || decodeURIComponent(m[1] as string) !== this.token) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
    const body = (await req.json()) as Record<string, any>;
    switch (m[2]) {
      case "getUpdates": {
        const offset = Number(body.offset ?? 0);
        this.getUpdatesOffsets.push(offset);
        if (this.failGetUpdates > 0) {
          this.failGetUpdates--;
          return new Response("boom", { status: 500 });
        }
        this.updates = this.updates.filter((u) => (u.update_id as number) >= offset);
        if (this.updates.length > 0) return this.json(this.updates);
        const timeoutMs = Math.min(Number(body.timeout ?? 0) * 1000, 2000);
        return new Promise<Response>((resolve) => {
          const waiter: Waiter = { offset, resolve: (u) => resolve(this.json(u)) };
          this.waiters.add(waiter);
          const done = () => {
            this.waiters.delete(waiter);
            resolve(this.json([]));
          };
          const t = setTimeout(done, timeoutMs);
          req.signal.addEventListener("abort", () => {
            clearTimeout(t);
            this.waiters.delete(waiter);
          });
        });
      }
      case "sendMessage": {
        if (this.rateLimitNextSend !== undefined) {
          const retry = this.rateLimitNextSend;
          this.rateLimitNextSend = undefined;
          return Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: retry } }, { status: 429 });
        }
        const messageId = this.nextMessageId++;
        this.sent.push({ chatId: Number(body.chat_id), messageId, text: String(body.text), replyMarkup: body.reply_markup, edits: [] });
        return this.json({ message_id: messageId, chat: { id: Number(body.chat_id), type: "private" }, date: 1, text: body.text });
      }
      case "editMessageText": {
        const msg = this.sent.find((s) => s.chatId === Number(body.chat_id) && s.messageId === body.message_id);
        if (!msg) return Response.json({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, { status: 400 });
        msg.edits.push({ text: String(body.text), replyMarkup: body.reply_markup });
        return this.json(true);
      }
      case "deleteMessage":
        this.deleted.push({ chatId: Number(body.chat_id), messageId: Number(body.message_id) });
        return this.json(true);
      case "answerCallbackQuery":
        this.answered.push({ id: String(body.callback_query_id), text: body.text });
        return this.json(true);
      case "getFile": {
        const file = this.files.get(String(body.file_id));
        if (!file) return Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
        return this.json({ file_id: body.file_id, file_path: file.path, file_size: file.reportedSize ?? file.bytes.length });
      }
      case "getMe":
        return this.json({ id: 1, is_bot: true, first_name: "Tropos", username: "tropos_bot" });
      case "setMyCommands":
        this.commands = body.commands;
        return this.json(true);
      default:
        return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
    }
  }
}
