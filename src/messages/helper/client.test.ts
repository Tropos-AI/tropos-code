// src/messages/helper/client.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HelperClient } from "./client";
import type { Exec } from "./install";

const APP = "/fake/Tropos Messages Helper.app";

let root: string;
let runDir: string;
let clock: number;
const now = () => clock;
/** Advances the fake clock and yields to the event loop so a fake helper can answer. */
const sleep = async (ms: number) => {
  clock += ms;
  await new Promise((r) => setTimeout(r, 1));
};

type Request = { id: string; token: string; lines: string[]; body?: Buffer };

/**
 * A fake helper behind `open -g`: like the applet, it takes every waiting request (deleting its files)
 * and answers each with whatever `answer` returns; `null` leaves it unanswered. A `deaf` helper never even
 * looks at its requests.
 */
function fakeHelper(answer: (req: Request) => string | null, opts: { delayMs?: number; deaf?: boolean } = {}) {
  const seen: Request[] = [];
  const opens: string[][] = [];
  const openTimeouts: (number | undefined)[] = [];
  const exec: Exec = async (cmd, args, timeoutMs) => {
    opens.push([cmd, ...args]);
    openTimeouts.push(timeoutMs);
    if (opts.deaf) return { code: 0, stdout: "", stderr: "" };
    const take = () => {
      for (const name of readdirSync(runDir).sort()) {
        const m = /^req-(.+)\.txt$/.exec(name);
        if (!m) continue;
        const id = m[1]!;
        const bodyPath = join(runDir, `req-${id}.body`);
        const [token, ...lines] = readFileSync(join(runDir, name), "utf8").split("\n");
        const req: Request = { id, token: token!, lines };
        if (existsSync(bodyPath)) req.body = readFileSync(bodyPath);
        rmSync(join(runDir, name));
        rmSync(bodyPath, { force: true });
        seen.push(req);
        const text = answer(req);
        if (text === null) continue;
        writeFileSync(join(runDir, `res-${id}.txt.tmp`), text);
        // The applet renames the finished reply into place.
        renameSync(join(runDir, `res-${id}.txt.tmp`), join(runDir, `res-${id}.txt`));
      }
    };
    if (opts.delayMs) setTimeout(take, opts.delayMs);
    else take();
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, seen, opens, openTimeouts };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tropos-helper-client-"));
  runDir = join(root, "user", ".local", "share", "tropos", "helpers", "run", "messages-helper");
  clock = 1_800_000_000_000;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const client = (exec: Exec) => new HelperClient({ runDir, appPath: APP, exec, now, sleep });

describe("HelperClient", () => {
  test("runDir is created 0700", async () => {
    const h = fakeHelper(() => "ok\n0");
    await client(h.exec).request("status", []);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
  });

  test("an existing runDir is tightened to 0700", async () => {
    mkdirSync(runDir, { recursive: true, mode: 0o755 });
    const h = fakeHelper(() => "ok\n0");
    await client(h.exec).request("status", []);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
  });

  test("the request is the action and its arguments, one per line, launched with open -g", async () => {
    const h = fakeHelper(() => "ok\n0");
    await client(h.exec).request("attachment", ["/a b/c'd.jpg", `${runDir}/snap-1`]);
    expect(h.seen[0]!.lines).toEqual(["attachment", "/a b/c'd.jpg", `${runDir}/snap-1`]);
    expect(h.seen[0]!.body).toBeUndefined();
    expect(h.opens[0]).toEqual(["/usr/bin/open", "-g", APP]);
  });

  test("every request starts with the install's token, created 0600 on first use", async () => {
    const h = fakeHelper(() => "ok\n0");
    await client(h.exec).request("status", []);
    const tokenPath = join(dirname(runDir), "token");
    const token = readFileSync(tokenPath, "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(h.seen[0]!.token).toBe(token);
    expect(h.seen[0]!.lines).toEqual(["status"]);
    // Another client of the same install reuses it.
    await client(h.exec).request("status", []);
    expect(h.seen[1]!.token).toBe(token);
  });

  test("a token that is a symlink or damaged is replaced", async () => {
    const tokenPath = join(dirname(runDir), "token");
    mkdirSync(dirname(tokenPath), { recursive: true });
    const decoy = join(root, "decoy");
    writeFileSync(decoy, "a".repeat(64));
    symlinkSync(decoy, tokenPath);
    const h = fakeHelper(() => "ok\n0");
    await client(h.exec).request("status", []);
    expect(lstatSync(tokenPath).isSymbolicLink()).toBe(false);
    expect(h.seen[0]!.token).not.toBe("a".repeat(64));
    expect(readFileSync(decoy, "utf8")).toBe("a".repeat(64));
    writeFileSync(tokenPath, "garbage");
    await client(h.exec).request("status", []);
    expect(h.seen[1]!.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("body arrives literally", async () => {
    const body = 'He said "hi"\n\\ ; do shell script "rm"\n👍 Καλημέρα';
    const h = fakeHelper(() => "ok\n0\nsent");
    const r = await client(h.exec).request("send-handle", ["+306912345678", "iMessage"], { body });
    expect(r).toEqual({ ok: true, lines: ["sent"] });
    expect(h.seen[0]!.lines).toEqual(["send-handle", "+306912345678", "iMessage"]);
    expect(h.seen[0]!.body!.equals(Buffer.from(body, "utf8"))).toBe(true);
  });

  test("replies are parsed", async () => {
    const answers: Record<string, string> = {
      status: "ok\n0\nfda=yes",
      probe: "error\n-1743\nNot authorized to send Apple events to Messages.",
      contacts: "ok\n0",
      snapshot: "error\neperm\ncp: chat.db: Operation not permitted\nsecond line",
      attachment: "garbage",
    };
    const h = fakeHelper((req) => answers[req.lines[0]!]!);
    const c = client(h.exec);
    expect(await c.request("status", [])).toEqual({ ok: true, lines: ["fda=yes"] });
    expect(await c.request("probe", [])).toEqual({ ok: false, code: "-1743", message: "Not authorized to send Apple events to Messages." });
    expect(await c.request("contacts", [`${runDir}/snap-1`])).toEqual({ ok: true, lines: [] });
    expect(await c.request("snapshot", [`${runDir}/snap-1`])).toEqual({
      ok: false,
      code: "eperm",
      message: "cp: chat.db: Operation not permitted\nsecond line",
    });
    expect(await c.request("attachment", ["/x", `${runDir}/snap-1`])).toMatchObject({ ok: false, code: "bad-reply" });
    // Replies are consumed.
    expect(readdirSync(runDir).filter((n) => n.startsWith("res-"))).toEqual([]);
  });

  test("times out without hanging", async () => {
    const h = fakeHelper(() => null, { deaf: true });
    const start = clock;
    const r = await client(h.exec).request("probe", [], { timeoutMs: 1_000 });
    expect(r).toMatchObject({ ok: false, code: "timeout" });
    if (!r.ok) expect(r.message).toMatch(/never picked/);
    expect(clock - start).toBeGreaterThanOrEqual(1_000);
    expect(clock - start).toBeLessThan(1_300);
    expect(readdirSync(runDir).filter((n) => n.startsWith("req-"))).toEqual([]);
  });

  test("a send's body is removed on timeout too", async () => {
    const h = fakeHelper(() => null, { deaf: true });
    const r = await client(h.exec).request("send-chat", ["iMessage;+;chat1"], { body: "hi", timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, code: "timeout" });
    expect(readdirSync(runDir)).toEqual([]);
  });

  test("a helper that took the request but never answered times out", async () => {
    const h = fakeHelper(() => null);
    const r = await client(h.exec).request("probe", [], { timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, code: "timeout" });
    if (!r.ok) expect(r.message).toMatch(/took the request/);
  });

  test("a request nobody picks up is launched again", async () => {
    const h = fakeHelper(() => null, { deaf: true });
    await client(h.exec).request("status", [], { timeoutMs: 5_000 });
    expect(h.opens.length).toBeGreaterThan(1);
    // Launching never waits longer than the request may.
    expect(h.openTimeouts[0]).toBe(5_000);
    for (const t of h.openTimeouts) expect(t).toBeLessThanOrEqual(5_000);
  });

  test("a helper that can't be launched is an error, and its request is withdrawn", async () => {
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "The file /fake/Tropos Messages Helper.app does not exist." });
    const r = await client(exec).request("status", []);
    expect(r).toMatchObject({ ok: false, code: "launch" });
    if (!r.ok) expect(r.message).toContain("does not exist");
    expect(readdirSync(runDir)).toEqual([]);
  });

  test("requests run one at a time", async () => {
    let waiting = 0;
    let most = 0;
    const exec: Exec = async (cmd, args) => {
      waiting = readdirSync(runDir).filter((n) => /^req-.+\.txt$/.test(n)).length;
      most = Math.max(most, waiting);
      return inner.exec(cmd, args);
    };
    const inner = fakeHelper((req) => `ok\n0\n${req.lines[1]}`, { delayMs: 5 });
    const c = client(exec);
    const replies = await Promise.all(["a", "b", "c"].map((x) => c.request("status", [x])));
    expect(replies).toEqual([
      { ok: true, lines: ["a"] },
      { ok: true, lines: ["b"] },
      { ok: true, lines: ["c"] },
    ]);
    expect(most).toBe(1);
    expect(inner.seen.map((r) => r.lines[1])).toEqual(["a", "b", "c"]);
  });

  test("a failed request doesn't block the next one", async () => {
    let first = true;
    const h = fakeHelper(() => "ok\n0");
    const exec: Exec = async (cmd, args) => {
      if (first) {
        first = false;
        throw new Error("spawn failed");
      }
      return h.exec(cmd, args);
    };
    const c = client(exec);
    const [a, b] = await Promise.all([c.request("status", []), c.request("status", [])]);
    expect(a).toMatchObject({ ok: false, code: "launch" });
    expect(b).toEqual({ ok: true, lines: [] });
  });

  test("arguments can't smuggle extra lines", async () => {
    const h = fakeHelper(() => "ok\n0");
    const c = client(h.exec);
    expect(await c.request("send-handle", ["+30\nopen-settings", "iMessage"], { body: "x" })).toMatchObject({ ok: false, code: "bad-request" });
    expect(await c.request("status\nprobe", [])).toMatchObject({ ok: false, code: "bad-request" });
    for (const sep of ["\r", "\u2028", "\u2029"]) {
      expect(await c.request("send-chat", [`chat1${sep}open-settings`], { body: "x" })).toMatchObject({ ok: false, code: "bad-request" });
    }
    expect(h.opens).toEqual([]);
  });

  test("old snapshot folders and leftovers are swept when it starts", async () => {
    mkdirSync(join(runDir, "snap-old", "x"), { recursive: true });
    mkdirSync(join(runDir, "snap-new"), { recursive: true });
    writeFileSync(join(runDir, "res-old.txt"), "ok\n0");
    writeFileSync(join(runDir, "req-old.txt"), "send-chat\nx");
    writeFileSync(join(runDir, "req-old.body"), "x");
    writeFileSync(join(runDir, "keep.txt"), "not ours");
    const old = new Date(clock - 10 * 60_000);
    for (const n of ["snap-old", "res-old.txt", "req-old.txt", "req-old.body", "keep.txt"]) utimesSync(join(runDir, n), old, old);
    const recent = new Date(clock - 5_000);
    utimesSync(join(runDir, "snap-new"), recent, recent);
    const h = fakeHelper(() => "ok\n0");
    await client(h.exec).request("status", []);
    expect(readdirSync(runDir).sort()).toEqual(["keep.txt", "snap-new"]);
    // The stale request was never handed to the helper.
    expect(h.seen.map((r) => r.lines[0])).toEqual(["status"]);
  });
});
