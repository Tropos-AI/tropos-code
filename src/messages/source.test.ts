// src/messages/source.test.ts — snapshot caching, cleanup and helper error mapping, with a fake helper client
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { HelperReply } from "./helper/client";
import { MessagesError, MessagesSource } from "./source";
import { buildAddressBook, buildChatDb } from "./testkit";

let root: string;
let runDir: string;
let fixtures: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "msg-source-"));
  runDir = join(root, "run");
  fixtures = join(root, "fixtures");
  mkdirSync(runDir);
  mkdirSync(fixtures);
  buildChatDb(join(fixtures, "chat.db"), {
    chats: [{ guid: "iMessage;-;+306912345678", handles: ["+306912345678"] }],
    messages: [{ guid: "m1", chat: "iMessage;-;+306912345678", handle: "+306912345678", text: "hi", at: Date.UTC(2026, 9, 1) }],
  });
  buildAddressBook(join(fixtures, "book.abcddb"), [{ first: "Maria", phones: ["+30 691 234 5678"] }]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Fake {
  calls: Array<{ action: string; args: string[] }>;
  request(action: string, args: string[]): Promise<HelperReply>;
}
function fakeClient(
  o: { snapshot?: HelperReply; contacts?: "none" | "book" | "outside"; gate?: () => Promise<void>; attachmentReply?: (dest: string) => string } = {},
): Fake {
  const calls: Fake["calls"] = [];
  return {
    calls,
    async request(action, args) {
      calls.push({ action, args });
      if (action === "snapshot") {
        if (o.snapshot) return o.snapshot;
        await o.gate?.();
        copyFileSync(join(fixtures, "chat.db"), join(args[0], "chat.db"));
        return { ok: true, lines: [] };
      }
      if (action === "contacts") {
        if (o.contacts === "none") return { ok: true, lines: [] };
        // Like the applet: copies to <dest>/contacts-<n>/ and lists the files relative to dest.
        const dir = join(args[0], "contacts-1");
        mkdirSync(dir);
        copyFileSync(join(fixtures, "book.abcddb"), join(dir, "AddressBook-v22.abcddb"));
        if (o.contacts === "outside") return { ok: true, lines: [join(fixtures, "book.abcddb"), "../../fixtures/book.abcddb"] };
        return { ok: true, lines: ["contacts-1/AddressBook-v22.abcddb"] };
      }
      if (action === "attachment") {
        // Like the applet: the destination is an existing snap- folder in the run folder; replies with the copy's path.
        if (!basename(args[1]).startsWith("snap-") || !statSync(args[1]).isDirectory()) return { ok: false, code: "bad-request", message: "not a snap- folder" };
        const copy = join(args[1], basename(args[0]));
        writeFileSync(copy, "pic");
        return { ok: true, lines: [o.attachmentReply ? o.attachmentReply(args[1]) : copy] };
      }
      return { ok: false, code: "bad-request", message: "?" };
    },
  };
}
const source = (client: Fake, clock: { t: number }, userHome = join(root, "home")) =>
  new MessagesSource({ client: client as never, runDir, userHome, now: () => clock.t });
const snaps = () => readdirSync(runDir).filter((n) => n.startsWith("snap-"));
const count = (c: Fake) => c.calls.filter((x) => x.action === "snapshot").length;

describe("MessagesSource", () => {
  test("two reads within 5 s share one snapshot; later a new one replaces it and the old folder is gone", async () => {
    const client = fakeClient();
    const clock = { t: 1000 };
    const s = source(client, clock);
    await s.with((db) => db.chats({ limit: 10 }));
    clock.t += 4_000;
    const chats = await s.with((db, contacts) => db.chats({ limit: 10 }).map((c) => c.name) && contacts.available);
    expect(chats).toBe(true);
    expect(count(client)).toBe(1);
    const first = snaps();
    expect(first).toHaveLength(1);
    clock.t += 2_000;
    await s.with(() => 0);
    expect(count(client)).toBe(2);
    expect(snaps()).toHaveLength(1);
    expect(snaps()[0]).not.toBe(first[0]);
    s.dispose();
  });

  test("fresh always takes a new snapshot", async () => {
    const client = fakeClient();
    const s = source(client, { t: 1 });
    await s.fresh(() => 0);
    await s.fresh(() => 0);
    expect(count(client)).toBe(2);
    expect(snaps()).toHaveLength(1);
    s.dispose();
  });

  test("dispose removes the snapshot folder", async () => {
    const s = source(fakeClient(), { t: 1 });
    await s.with(() => 0);
    expect(snaps()).toHaveLength(1);
    s.dispose();
    expect(snaps()).toHaveLength(0);
  });

  test("fda=no maps to no-full-disk-access with a plain-words text, and leaves no folder", async () => {
    const s = source(fakeClient({ snapshot: { ok: false, code: "eperm", message: "Operation not permitted" } }), { t: 1 });
    const err = await s.with(() => 0).catch((e) => e);
    expect(err).toBeInstanceOf(MessagesError);
    expect(err.code).toBe("no-full-disk-access");
    expect(err.message).toContain("Full Disk Access");
    expect(err.message).toContain("Tropos Messages Helper");
    expect(err.message).toContain("Don't retry until the user says it's fixed.");
    expect(snaps()).toHaveLength(0);
  });

  test("other helper codes map to their own errors", async () => {
    const run = async (reply: HelperReply) => (await source(fakeClient({ snapshot: reply }), { t: 1 }).with(() => 0).catch((e) => e)) as MessagesError;
    expect((await run({ ok: false, code: "-1743", message: "x" })).code).toBe("no-automation");
    expect((await run({ ok: false, code: "timeout", message: "x" })).code).toBe("timeout");
    const other = await run({ ok: false, code: "weird", message: "kaboom" });
    expect(other.code).toBe("helper");
    expect(other.message).toContain("kaboom");
  });

  test("a missing address book leaves contacts unavailable but reads still work", async () => {
    const s = source(fakeClient({ contacts: "none" }), { t: 1 });
    const out = await s.with((db, contacts) => ({ available: contacts.available, chats: db.chats({ limit: 5 }).length }));
    expect(out).toEqual({ available: false, chats: 1 });
    s.dispose();
  });

  test("names come from the address book; canonicalHandle matches a differently written handle", async () => {
    const s = source(fakeClient(), { t: 1 });
    expect(s.canonicalHandle("6912345678")).toBeUndefined();
    const name = await s.with((db) => db.chats({ limit: 5 })[0].name);
    expect(name).toBe("Maria");
    expect(s.lastContacts()?.available).toBe(true);
    expect(s.canonicalHandle("+30 691-234 5678")).toBe("+306912345678");
    expect(s.canonicalHandle("0030 6912345678")).toBe("+306912345678");
    expect(s.canonicalHandle("+14155550123")).toBeUndefined();
    s.dispose();
  });

  test("a snapshot still in use survives being replaced until its reader finishes", async () => {
    const clock = { t: 1 };
    const s = source(fakeClient(), clock);
    let release!: () => void;
    const slow = s.with(async (db) => {
      await new Promise<void>((r) => (release = r));
      return db.chats({ limit: 5 }).length;
    });
    await Bun.sleep(20);
    clock.t += 10_000;
    await s.with(() => 0);
    expect(snaps()).toHaveLength(2);
    release();
    expect(await slow).toBe(1);
    expect(snaps()).toHaveLength(1);
    s.dispose();
  });

  test("a contacts line pointing outside the snapshot folder is ignored", async () => {
    const s = source(fakeClient({ contacts: "outside" }), { t: 1 });
    expect(await s.with((_db, contacts) => contacts.available)).toBe(false);
    s.dispose();
  });

  test("an attachment reply outside the folder is refused and cleaned up", async () => {
    buildChatDb(join(fixtures, "chat.db"), {
      chats: [{ guid: "c", handles: ["+306912345678"] }],
      messages: [{ guid: "a", chat: "c", handle: "+306912345678", text: "p", at: 1, attachments: [{ filename: "~/Library/Messages/Attachments/x/pic.jpg", name: "pic.jpg" }] }],
    });
    const s = source(fakeClient({ attachmentReply: () => join(fixtures, "chat.db") }), { t: 1 });
    const err = await s.attachmentCopy(1).catch((e) => e);
    expect(err.code).toBe("helper");
    expect(snaps().filter((n) => n.startsWith("snap-att-"))).toHaveLength(0);
    s.dispose();
  });

  test("fresh waits out a snapshot already under way and takes a new one after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const client = fakeClient({
      gate: async () => {
        if (first) {
          first = false;
          await gate;
        }
      },
    });
    const s = source(client, { t: 1 });
    const early = s.with(() => 0);
    await Bun.sleep(20);
    const late = s.fresh(() => 0);
    await Bun.sleep(20);
    expect(count(client)).toBe(1);
    release();
    await Promise.all([early, late]);
    expect(count(client)).toBe(2);
    s.dispose();
  });

  test("dispose during a snapshot leaves no folder behind and later reads reject", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = source(fakeClient({ gate: () => gate }), { t: 1 });
    const pending = s.with(() => 0).catch((e) => e);
    await Bun.sleep(20);
    s.dispose();
    release();
    expect(await pending).toBeInstanceOf(MessagesError);
    expect(snaps()).toHaveLength(0);
    await expect(s.with(() => 0)).rejects.toBeInstanceOf(MessagesError);
    await expect(s.fresh(() => 0)).rejects.toBeInstanceOf(MessagesError);
  });

  test("fda=no as a helper code also maps to no-full-disk-access", async () => {
    const s = source(fakeClient({ snapshot: { ok: false, code: "fda=no", message: "" } }), { t: 1 });
    expect(((await s.with(() => 0).catch((e) => e)) as MessagesError).code).toBe("no-full-disk-access");
  });

  test("attachmentCopy asks the helper for a file under the attachments folder only", async () => {
    const home = join(root, "home");
    buildChatDb(join(fixtures, "chat.db"), {
      chats: [{ guid: "c", handles: ["+306912345678"] }],
      messages: [
        { guid: "a", chat: "c", handle: "+306912345678", text: "p", at: 1, attachments: [{ filename: "~/Library/Messages/Attachments/ab/cd/pic.jpg", mime: "image/jpeg", name: "pic.jpg" }] },
        { guid: "b", chat: "c", handle: "+306912345678", text: "q", at: 2, attachments: [{ filename: "~/Documents/secret.txt", name: "secret.txt" }] },
      ],
    });
    const client = fakeClient();
    const s = source(client, { t: 1 }, home);
    const ok = await s.attachmentCopy(1);
    expect(ok.name).toBe("pic.jpg");
    expect(ok.mime).toBe("image/jpeg");
    expect(existsSync(ok.path)).toBe(true);
    const call = client.calls.find((c) => c.action === "attachment")!;
    expect(call.args[0]).toBe(`${home}/Library/Messages/Attachments/ab/cd/pic.jpg`);
    expect(basename(call.args[1]).startsWith("snap-")).toBe(true);
    expect(ok.path).toBe(join(call.args[1], "pic.jpg"));
    await expect(s.attachmentCopy(2)).rejects.toBeInstanceOf(MessagesError);
    await expect(s.attachmentCopy(99)).rejects.toBeInstanceOf(MessagesError);
    s.dispose();
    expect(existsSync(ok.path)).toBe(false);
  });
});
