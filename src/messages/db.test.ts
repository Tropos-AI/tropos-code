// src/messages/db.test.ts — the chat.db reader over fixture databases
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessagesDb } from "./db";
import { buildChatDb, type ChatDbFixture } from "./testkit";

const dirs: string[] = [];
const opened: Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NAMES: Record<string, string> = { "+306912345678": "Maria Papadopoulou", "+306900000001": "Nikos" };
const names = (handle: string) => NAMES[handle];

const MARIA = "iMessage;-;+306912345678";
const SMS = "SMS;-;+14155550123";
const GROUP = "iMessage;+;chat123";
const T = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;

function fixture(variant: "sonoma" | "older" = "sonoma"): ChatDbFixture {
  return {
    variant,
    chats: [
      { guid: MARIA, handles: ["+306912345678"] },
      { guid: SMS, handles: ["+14155550123"], service: "SMS" },
      { guid: GROUP, displayName: "Trip", handles: ["+306912345678", "+306900000001"] },
    ],
    messages: [
      { guid: "m1", chat: MARIA, handle: "+306912345678", text: "hello there", at: T, read: true },
      { guid: "m2", chat: MARIA, fromMe: true, text: "hi Maria", at: T + MIN },
      { guid: "m3", chat: MARIA, handle: "+306912345678", bodyOnly: "the invoice is attached", at: T + 2 * MIN, read: false, attachments: [{ filename: "~/Library/Messages/Attachments/ab/12/x/IMG_1.heic", mime: "image/heic", name: "IMG_1.heic", bytes: 2048 }] },
      { guid: "m4", chat: MARIA, handle: "+306900000001", assocType: 2000, assocGuid: "p:0/m3", text: "Loved “the invoice”", at: T + 3 * MIN },
      { guid: "s1", chat: SMS, handle: "+14155550123", text: "your code is 1234", at: T + 10 * MIN, read: false },
      { guid: "g1", chat: GROUP, handle: "+306900000001", text: "who is coming?", at: T + 5 * MIN, read: false },
    ],
  };
}

function open(fx: ChatDbFixture = fixture()): MessagesDb {
  const dir = mkdtempSync(join(tmpdir(), "chatdb-"));
  dirs.push(dir);
  const path = join(dir, "chat.db");
  buildChatDb(path, fx);
  const db = new Database(path, { readonly: true });
  opened.push(db);
  return new MessagesDb(db, names, "/Users/tester");
}

describe("chats", () => {
  test("lists every chat newest first with unread counted", () => {
    const chats = open().chats({ limit: 50 });
    expect(chats.map((c) => c.id)).toEqual([SMS, GROUP, MARIA]);
    expect(chats.map((c) => c.unread)).toEqual([1, 1, 1]);
    const [sms, group, maria] = chats;
    expect(sms?.service).toBe("SMS");
    expect(group).toMatchObject({ name: "Trip", isGroup: true });
    expect(group?.participants).toEqual([{ handle: "+306912345678", name: "Maria Papadopoulou" }, { handle: "+306900000001", name: "Nikos" }]);
    expect(maria).toMatchObject({ name: "Maria Papadopoulou", isGroup: false, lastAt: T + 2 * MIN });
    expect(sms?.name).toBe("+14155550123");
  });

  test("honours the limit and finds chats by contact name or handle", () => {
    const db = open();
    expect(db.chats({ limit: 1 })).toHaveLength(1);
    expect(db.chats({ query: "maria", limit: 50 }).map((c) => c.id)).toEqual([GROUP, MARIA]);
    expect(db.chats({ query: "415 555 0123", limit: 50 }).map((c) => c.id)).toEqual([SMS]);
    expect(db.chats({ query: "trip", limit: 50 }).map((c) => c.id)).toEqual([GROUP]);
  });
});

describe("read", () => {
  test("returns the last messages oldest to newest, with the tapback folded in", () => {
    const messages = open().read(MARIA, { limit: 2 });
    expect(messages.map((m) => m.guid)).toEqual(["m2", "m3"]);
    expect(messages[1]).toMatchObject({ text: "the invoice is attached", fromMe: false, reactions: ["❤️ by Nikos"] });
    expect(messages[1]?.sender).toEqual({ handle: "+306912345678", name: "Maria Papadopoulou" });
    expect(messages[0]).toMatchObject({ fromMe: true, text: "hi Maria", at: T + MIN });
    expect(messages[0]?.sender).toBeUndefined();
  });

  test("lists attachments and pages with before and after", () => {
    const db = open();
    const all = db.read(MARIA, { limit: 50 });
    expect(all.map((m) => m.guid)).toEqual(["m1", "m2", "m3"]);
    expect(all[2]?.attachments).toEqual([{ id: 1, name: "IMG_1.heic", mime: "image/heic", bytes: 2048 }]);
    expect(db.read(MARIA, { before: T + 2 * MIN, limit: 50 }).map((m) => m.guid)).toEqual(["m1", "m2"]);
    expect(db.read(MARIA, { after: T, limit: 1 }).map((m) => m.guid)).toEqual(["m2"]);
  });

  test("a removed tapback leaves no reaction", () => {
    const fx = fixture();
    fx.messages.push({ guid: "m5", chat: MARIA, handle: "+306900000001", assocType: 3000, assocGuid: "p:0/m3", at: T + 4 * MIN });
    expect(open(fx).read(MARIA, { limit: 50 }).find((m) => m.guid === "m3")?.reactions).toEqual([]);
  });

  test("replyTo carries the replied-to guid", () => {
    const fx = fixture();
    fx.messages.push({ guid: "m6", chat: MARIA, fromMe: true, text: "yes", replyTo: "m1", at: T + 6 * MIN });
    expect(open(fx).read(MARIA, { limit: 1 })[0]?.replyTo).toBe("m1");
  });
});

describe("cursors and degenerate input", () => {
  const n1 = 700000000123456789;
  const n2 = 700000001123456789;
  const withNanos = (): ChatDbFixture => ({
    chats: [{ guid: MARIA, handles: ["+306912345678"] }],
    messages: [
      { guid: "n1", chat: MARIA, handle: "+306912345678", text: "one", at: 0, rawDate: n1 },
      { guid: "n2", chat: MARIA, handle: "+306912345678", text: "two", at: 0, rawDate: n2 },
    ],
  });
  test("a cursor taken from a message never returns that message again", () => {
    const db = open(withNanos());
    const [first, second] = db.read(MARIA, { limit: 50 });
    expect(first?.guid).toBe("n1");
    expect(db.read(MARIA, { before: second!.at, limit: 50 }).map((m) => m.guid)).toEqual(["n1"]);
    expect(db.read(MARIA, { before: first!.at, limit: 50 })).toEqual([]);
    expect(db.read(MARIA, { after: first!.at, limit: 50 }).map((m) => m.guid)).toEqual(["n2"]);
    expect(db.read(MARIA, { after: second!.at, limit: 50 })).toEqual([]);
  });
  test("a query with no letters or digits does not match every chat", () => {
    const db = open();
    expect(db.chats({ query: "-", limit: 50 })).toEqual([]);
    expect(db.chats({ query: "()", limit: 50 })).toEqual([]);
  });
  test("an empty reply_to_guid falls through to the thread originator", () => {
    const fx = fixture();
    fx.messages.push({ guid: "r1", chat: MARIA, fromMe: true, text: "re", replyTo: "", threadOriginator: "m1", at: T + 6 * MIN });
    expect(open(fx).read(MARIA, { limit: 1 })[0]?.replyTo).toBe("m1");
  });
});

describe("search", () => {
  test("finds text that lives only in attributedBody", () => {
    const hits = open().search("INVOICE", { limit: 25 });
    expect(hits.map((h) => h.message.guid)).toEqual(["m3"]);
    expect(hits[0]?.chat.id).toBe(MARIA);
  });

  test("filters by chat and since, newest first, honouring the limit", () => {
    const db = open();
    expect(db.search("o", { chat: SMS, limit: 25 }).map((h) => h.message.guid)).toEqual(["s1"]);
    expect(db.search("hello", { since: T + MIN, limit: 25 })).toEqual([]);
    expect(db.search("o", { limit: 2 }).map((h) => h.message.guid)).toEqual(["s1", "g1"]);
  });
});

describe("activity", () => {
  test("counts received and sent per chat since a time", () => {
    const rows = open().activity(T + MIN, 10);
    expect(rows.map((r) => r.chat.id)).toEqual([SMS, GROUP, MARIA]);
    const maria = rows.find((r) => r.chat.id === MARIA);
    expect(maria).toMatchObject({ received: 1, sent: 1 });
    expect(maria?.last?.guid).toBe("m3");
    expect(open().activity(T + 20 * MIN, 10)).toEqual([]);
    expect(open().activity(T, 1)).toHaveLength(1);
  });
});

describe("attachment", () => {
  test("expands ~ to the given home", () => {
    expect(open().attachment(1)).toEqual({ path: "/Users/tester/Library/Messages/Attachments/ab/12/x/IMG_1.heic", name: "IMG_1.heic", mime: "image/heic", bytes: 2048 });
    expect(open().attachment(99)).toBeUndefined();
  });
});

describe("sentSince", () => {
  test("finds a sent row with the same text and reports delivery", () => {
    const fx = fixture();
    fx.messages.push({ guid: "out", chat: MARIA, fromMe: true, text: "on my way", at: T + 30 * MIN, delivered: false, error: 22 });
    const db = open(fx);
    expect(db.sentSince(MARIA, T + 29 * MIN, "on my way")).toEqual({ delivered: false, error: 22 });
    expect(db.sentSince("6912345678", T + 29 * MIN, "on my way")).toEqual({ delivered: false, error: 22 });
    expect(db.sentSince(MARIA, T + 31 * MIN, "on my way")).toBeUndefined();
    expect(db.sentSince(MARIA, T + 29 * MIN, "something else")).toBeUndefined();
    expect(db.sentSince(GROUP, T + 29 * MIN, "on my way")).toBeUndefined();
  });
});

describe("handles", () => {
  test("lists each normalized stored handle once", () => {
    expect(open().handles().sort()).toEqual(["+14155550123", "+306900000001", "+306912345678"]);
  });
});

describe("older schema", () => {
  test("reads without attributedBody or thread_originator_guid", () => {
    const db = open(fixture("older"));
    expect(db.chats({ limit: 50 })).toHaveLength(3);
    const messages = db.read(MARIA, { limit: 50 });
    expect(messages.map((m) => m.guid)).toEqual(["m1", "m2", "m3"]);
    expect(messages[2]?.text).toBe("");
    expect(messages[2]?.reactions).toEqual(["❤️ by Nikos"]);
    expect(db.search("hello", { limit: 5 })).toHaveLength(1);
  });
});
