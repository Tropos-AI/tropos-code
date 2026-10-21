// src/messages/messages-tool.test.ts — the Messages tool against a testkit chat.db behind a fake helper client
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, copyFileSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ToolContext, ToolOutput } from "../tools/types";
import { MESSAGES_PREAMBLE, createMessagesTool } from "./messages-tool";
import { MessagesError, MessagesSource } from "./source";
import { buildAddressBook, buildChatDb } from "./testkit";

const CHAT = "iMessage;-;+306912345678";
const T0 = Date.UTC(2026, 9, 1, 12);
let root: string;
let source: MessagesSource;
let failWith: MessagesError | undefined;

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function setup(opts: { count: number; long?: boolean }) {
  const messages = Array.from({ length: opts.count }, (_, i) => ({
    guid: `m${i}`,
    chat: CHAT,
    handle: "+306912345678",
    text: `${i} invoice ${opts.long ? "x".repeat(300) : "hello"}`,
    at: T0 + i * 60_000,
  }));
  const img = join(root, "home", "Library", "Messages", "Attachments", "ab", "pic.png");
  mkdirSync(join(img, ".."), { recursive: true });
  writeFileSync(img, PNG);
  const doc = join(root, "home", "Library", "Messages", "Attachments", "ab", "note.txt");
  writeFileSync(doc, "hello");
  messages.push({
    guid: "att", chat: CHAT, handle: "+306912345678", text: "pic", at: T0 + 10_000_000,
    attachments: [
      { filename: img, mime: "image/png", name: "pic.png", bytes: PNG.length },
      { filename: doc, mime: "text/plain", name: "note.txt", bytes: 5 },
    ],
  } as never);
  buildChatDb(join(root, "fixtures", "chat.db"), { chats: [{ guid: CHAT, handles: ["+306912345678"] }], messages });
}

let requests: string[] = [];

function makeSource(): MessagesSource {
  const client = {
    async request(action: string, args: string[]) {
      requests.push(action);
      if (failWith) return { ok: false as const, code: "eperm", message: "x" };
      if (action === "snapshot") {
        copyFileSync(join(root, "fixtures", "chat.db"), join(args[0], "chat.db"));
        return { ok: true as const, lines: [] };
      }
      if (action === "contacts") {
        const dir = join(args[0], "contacts-0");
        mkdirSync(dir);
        copyFileSync(join(root, "fixtures", "book.abcddb"), join(dir, "AddressBook-v22.abcddb"));
        return { ok: true as const, lines: [dir] };
      }
      if (action === "attachment") {
        const dest = join(args[1], basename(args[0]));
        copyFileSync(args[0], dest);
        return { ok: true as const, lines: [dest] };
      }
      return { ok: false as const, code: "bad-request", message: "?" };
    },
  };
  return new MessagesSource({ client: client as never, runDir: join(root, "run"), userHome: join(root, "home") });
}

const ctx = { signal: new AbortController().signal } as unknown as ToolContext;
const text = (o: ToolOutput) => (typeof o.content === "string" ? o.content : JSON.stringify(o.content));
const run = (input: Record<string, unknown>) => createMessagesTool(source).run(input as never, ctx);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "msg-tool-"));
  mkdirSync(join(root, "run"));
  mkdirSync(join(root, "fixtures"));
  buildAddressBook(join(root, "fixtures", "book.abcddb"), [{ first: "Maria", last: "Papadopoulou", phones: ["+30 691 234 5678"] }]);
  failWith = undefined;
  requests = [];
});
afterEach(() => {
  source?.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("Messages tool", () => {
  test("every action starts with the preamble", async () => {
    setup({ count: 3 });
    source = makeSource();
    const inputs = [
      { action: "chats" },
      { action: "read", chat: CHAT },
      { action: "search", query: "invoice" },
      { action: "activity", since: "2026-09-01T00:00:00Z" },
      { action: "contacts", query: "maria" },
    ];
    for (const input of inputs) {
      const out = await run(input);
      expect(out.isError).toBeUndefined();
      expect(text(out).startsWith(MESSAGES_PREAMBLE)).toBe(true);
    }
    expect(text(await run({ action: "contacts", query: "maria" }))).toContain("Maria Papadopoulou");
  });

  test("read clamps limit 999 to 200", async () => {
    setup({ count: 250 });
    source = makeSource();
    const out = await run({ action: "read", chat: CHAT, limit: 999 });
    expect(text(out).match(/ invoice /g)?.length).toBe(199); // 200 newest, one of them the attachment message
  });

  test("a long chat is cut at 20 000 characters and says how to continue", async () => {
    setup({ count: 120, long: true });
    source = makeSource();
    const out = await run({ action: "read", chat: CHAT, limit: 200 });
    const body = text(out);
    expect(body.length).toBeLessThanOrEqual(20_000);
    expect(body).toContain("more: use before=");
    expect(body.trimEnd().endsWith("</messages>")).toBe(true);
  });

  test("read without chat names the field", async () => {
    setup({ count: 1 });
    source = makeSource();
    const out = await run({ action: "read" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("chat");
  });

  test("an unparseable time names the field", async () => {
    setup({ count: 1 });
    source = makeSource();
    const out = await run({ action: "read", chat: CHAT, before: "yesterday-ish" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("before");
  });

  test("a MessagesError becomes an error result with its plain text", async () => {
    setup({ count: 1 });
    source = makeSource();
    failWith = new MessagesError("no-full-disk-access");
    const out = await run({ action: "chats" });
    expect(out.isError).toBe(true);
    expect(text(out)).toBe(new MessagesError("no-full-disk-access").message);
  });

  test("an unknown chat is reported as no such chat", async () => {
    setup({ count: 1 });
    source = makeSource();
    const out = await run({ action: "read", chat: "iMessage;-;nobody" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("No such chat");
  });

  test("a non-image attachment gives name, type and size only", async () => {
    setup({ count: 1 });
    source = makeSource();
    const found = await source.with((db) => db.read(CHAT, { limit: 5 }).flatMap((m) => m.attachments));
    const doc = found.find((a) => a.name === "note.txt");
    const out = await run({ action: "attachment", id: doc?.id });
    expect(out.isError).toBeUndefined();
    expect(text(out)).toContain("note.txt");
    expect(text(out)).toContain("text/plain");
    expect(text(out)).toContain("5 B");
    // chat.db already says what it is, so nothing is copied out of Messages.
    expect(requests).not.toContain("attachment");
    expect(readdirSync(join(root, "run")).filter((n) => n.startsWith("snap-att-"))).toEqual([]);
  });

  test("an attachment of unknown type is copied to look at it, and the copy is deleted right after", async () => {
    setup({ count: 1 });
    const blob = join(root, "home", "Library", "Messages", "Attachments", "ab", "blob");
    writeFileSync(blob, "not a picture");
    buildChatDb(join(root, "fixtures", "chat.db"), {
      chats: [{ guid: CHAT, handles: ["+306912345678"] }],
      messages: [{ guid: "u", chat: CHAT, handle: "+306912345678", text: "?", at: T0, attachments: [{ filename: blob, name: "blob" }] }],
    });
    source = makeSource();
    const [att] = await source.with((db) => db.read(CHAT, { limit: 5 }).flatMap((m) => m.attachments));
    const out = await run({ action: "attachment", id: att?.id });
    expect(out.isError).toBeUndefined();
    expect(text(out)).toContain("not an image");
    expect(requests).toContain("attachment");
    expect(readdirSync(join(root, "run")).filter((n) => n.startsWith("snap-att-"))).toEqual([]);
  });

  test.skipIf(process.platform !== "darwin")("an image attachment comes back as a downscaled jpeg image block", async () => {
    setup({ count: 1 });
    source = makeSource();
    const found = await source.with((db) => db.read(CHAT, { limit: 5 }).flatMap((m) => m.attachments));
    const pic = found.find((a) => a.name === "pic.png");
    const out = await run({ action: "attachment", id: pic?.id });
    expect(out.isError).toBeUndefined();
    const block = (out.content as Array<{ type: string; source?: { media_type: string; data: string } }>)[1];
    expect(block.type).toBe("image");
    expect(block.source?.media_type).toBe("image/jpeg");
    expect(Buffer.from(block.source?.data ?? "", "base64")[0]).toBe(0xff);
    // The copy and its resized jpeg are gone once the image is in the result.
    expect(readdirSync(join(root, "run")).filter((n) => n.startsWith("snap-att-"))).toEqual([]);
  });

  test("an image result opens with the preamble before the image", async () => {
    if (process.platform !== "darwin") return;
    setup({ count: 1 });
    source = makeSource();
    const found = await source.with((db) => db.read(CHAT, { limit: 5 }).flatMap((m) => m.attachments));
    const out = await run({ action: "attachment", id: found.find((a) => a.name === "pic.png")?.id });
    const blocks = out.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text?.startsWith(MESSAGES_PREAMBLE)).toBe(true);
    expect(blocks[1]?.type).toBe("image");
  });

  test("the non-image reply is wrapped in the preamble", async () => {
    setup({ count: 1 });
    source = makeSource();
    const found = await source.with((db) => db.read(CHAT, { limit: 5 }).flatMap((m) => m.attachments));
    const out = await run({ action: "attachment", id: found.find((a) => a.name === "note.txt")?.id });
    expect(text(out).startsWith(MESSAGES_PREAMBLE)).toBe(true);
    expect(text(out)).toContain("</messages>");
  });

  test("an attachment over 100 MB is refused before copying, and a copy found too big is deleted", async () => {
    setup({ count: 1 });
    const big = join(root, "home", "Library", "Messages", "Attachments", "ab", "evil\nname.bin");
    const fd = openSync(big, "w");
    ftruncateSync(fd, 101 * 1024 * 1024);
    closeSync(fd);
    const msgs = [
      { guid: "b1", chat: CHAT, handle: "+306912345678", text: "known", at: T0, attachments: [{ filename: big, mime: "application/octet-stream", name: "evil\nname.bin", bytes: 101 * 1024 * 1024 }] },
      { guid: "b2", chat: CHAT, handle: "+306912345678", text: "unknown", at: T0 + 1, attachments: [{ filename: big, name: "evil\nname.bin" }] },
    ];
    buildChatDb(join(root, "fixtures", "chat.db"), { chats: [{ guid: CHAT, handles: ["+306912345678"] }], messages: msgs as never });
    source = makeSource();
    const ids = await source.with((db) => db.read(CHAT, { limit: 5 }).flatMap((m) => m.attachments.map((a) => a.id)));
    expect(ids).toHaveLength(2);
    const before = readdirSync(join(root, "run")).filter((n) => n.startsWith("snap-att-")).length;
    for (const id of ids) {
      const out = await run({ action: "attachment", id });
      expect(out.isError).toBe(true);
      expect(text(out)).toContain("100 MB");
      expect(text(out)).not.toContain("evil");
    }
    const left = readdirSync(join(root, "run")).filter((n) => n.startsWith("snap-att-"));
    expect(left.length).toBe(before);
  });

  test("limits are clamped for chats, search, activity and contacts", async () => {
    const seen: Record<string, number> = {};
    const fakeSource = {
      async with(fn: (db: unknown, c: unknown) => unknown) {
        const db = {
          chats: (o: { limit: number }) => ((seen.chats = o.limit), []),
          search: (_q: string, o: { limit: number }) => ((seen.search = o.limit), []),
          activity: (_s: number, limit: number) => ((seen.activity = limit), []),
        };
        return fn(db, { find: (_q: string, limit: number) => ((seen.contacts = limit), []) });
      },
      lastContacts: () => undefined,
    };
    const tool = createMessagesTool(fakeSource as never);
    for (const input of [{ action: "chats" }, { action: "search", query: "a" }, { action: "activity" }, { action: "contacts", query: "a" }]) {
      await tool.run({ ...input, limit: 99999 } as never, ctx);
    }
    expect(seen).toEqual({ chats: 500, search: 100, activity: 200, contacts: 50 });
    seen.chats = 0;
    await tool.run({ action: "chats" } as never, ctx);
    expect(seen.chats).toBe(50);
  });

  test("summarize and subject", () => {
    source = makeSource();
    const tool = createMessagesTool(source);
    expect(tool.kind).toBe("read");
    expect(tool.summarize({ action: "search", query: "invoice" } as never)).toBe('search "invoice"');
    expect(tool.subject({ action: "chats" } as never, "/")).toEqual({ paths: [] });
  });
});
