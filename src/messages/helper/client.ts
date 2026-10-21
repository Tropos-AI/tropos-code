// src/messages/helper/client.ts — talks to the Tropos Messages Helper through request/response files
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { helperTokenPath } from "./applet";
import type { Exec } from "./install";

/**
 * A helper answer. Error codes: from the helper `bad-request`, `unauthorized` (wrong token), `eperm` (macOS refused the file, i.e. no
 * Full Disk Access) or an AppleScript error number such as `-1743` (no Automation permission); from the
 * client `timeout`, `launch` (the app couldn't be started) and `bad-reply`.
 */
export type HelperReply = { ok: true; lines: string[] } | { ok: false; code: string; message: string };

const DEFAULT_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 180_000;
const POLL_MS = 100;
/** A request still waiting this long was missed by the helper (it quit just as it arrived); launch it again. */
const RELAUNCH_MS = 2_000;
const SNAPSHOT_MAX_AGE_MS = 60_000;
/** Older than any request's deadline, so a live request of another Tropos process is never swept. */
const STALE_FILE_MS = SEND_TIMEOUT_MS + 20_000;
const ACTION = /^[a-z][a-z-]*$/;
/** Anything AppleScript's `paragraphs of` would split a request line at. */
const LINE_BREAK = /[\r\n\u2028\u2029]/;
const TOKEN = /^[0-9a-f]{64}$/;

/**
 * One connection to the helper app. Each request is a `req-<id>.txt` (the install's token, the action, then
 * one argument per line) plus, for sends, the text in `req-<id>.body`, which is written first and
 * byte-for-byte. The token (`<runDir>/../token`, 32 random bytes as hex, mode 0600) is created on first use;
 * the helper ignores requests without it. The client then
 * runs `open -g` on the app and polls every 100 ms for `res-<id>.txt`. Requests run one at a time. On a
 * timeout the request files are deleted, so a helper launched later can't act on a request nobody waits for.
 */
export class HelperClient {
  private readonly runDir: string;
  private readonly appPath: string;
  private readonly exec: Exec;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private swept = false;

  constructor(o: { runDir: string; appPath: string; exec: Exec; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.runDir = o.runDir;
    this.appPath = o.appPath;
    this.exec = o.exec;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Sends one request and waits for its answer; `timeoutMs` defaults to 10 s, or 3 min for `send-*`. */
  request(action: string, args: string[], opts: { body?: string; timeoutMs?: number } = {}): Promise<HelperReply> {
    const next = this.queue.then(() => this.exchange(action, args, opts));
    this.queue = next.catch(() => {});
    return next;
  }

  private async exchange(action: string, args: string[], opts: { body?: string; timeoutMs?: number }): Promise<HelperReply> {
    if (!ACTION.test(action)) return { ok: false, code: "bad-request", message: `not a helper action: ${JSON.stringify(action)}` };
    if (args.some((a) => LINE_BREAK.test(a))) return { ok: false, code: "bad-request", message: "a helper argument can't contain a line break" };
    const timeoutMs = opts.timeoutMs ?? (action.startsWith("send-") ? SEND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

    // Both `helpers/run` and the run folder are private; folders that already existed are tightened.
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    await chmod(dirname(this.runDir), 0o700);
    await chmod(this.runDir, 0o700);
    if (!this.swept) {
      this.swept = true;
      await this.sweep();
    }
    const token = await this.token();

    const id = `${String(Math.max(0, Math.floor(this.now()))).padStart(13, "0")}-${randomBytes(6).toString("hex")}`;
    const reqPath = join(this.runDir, `req-${id}.txt`);
    const bodyPath = join(this.runDir, `req-${id}.body`);
    const resPath = join(this.runDir, `res-${id}.txt`);
    const withdraw = () => Promise.all([rm(reqPath, { force: true }), rm(bodyPath, { force: true })]);

    if (opts.body !== undefined) await writeFile(bodyPath, opts.body, { encoding: "utf8", mode: 0o600 });
    // Written aside and renamed, so the helper never reads half a request.
    const pending = join(this.runDir, `req-${id}.pending`);
    await writeFile(pending, [token, action, ...args].join("\n"), { encoding: "utf8", mode: 0o600 });
    await rename(pending, reqPath);

    const start = this.now();
    let launched = start;
    const launch = await this.launch(timeoutMs);
    if (launch) {
      await withdraw();
      return { ok: false, code: "launch", message: launch };
    }

    for (;;) {
      const reply = await readFile(resPath, "utf8").catch(() => undefined);
      if (reply !== undefined) {
        await rm(resPath, { force: true });
        return parseReply(reply);
      }
      const waiting = await exists(reqPath);
      const t = this.now();
      if (t - start >= timeoutMs) {
        await withdraw();
        const seconds = Math.round(timeoutMs / 100) / 10;
        const where = waiting
          ? "it never picked the request up"
          : "it took the request but didn't finish; Messages may be busy, not signed in, or waiting for a permission prompt";
        return { ok: false, code: "timeout", message: `Tropos Messages Helper didn't answer within ${seconds} s (${where}).` };
      }
      if (waiting && t - launched >= RELAUNCH_MS) {
        launched = t;
        await this.launch(start + timeoutMs - t);
      }
      await this.sleep(POLL_MS);
    }
  }

  /** Starts the helper in the background, waiting no longer than the request may; returns why it couldn't, or undefined. */
  private async launch(remainingMs: number): Promise<string | undefined> {
    try {
      const r = await this.exec("/usr/bin/open", ["-g", this.appPath], Math.max(1, Math.min(15_000, remainingMs)));
      if (r.code === 0) return undefined;
      return (r.stderr || r.stdout).trim() || `open exited with ${r.code ?? "no code"}`;
    } catch (err) {
      return (err as Error).message;
    }
  }

  /**
   * The install's request token, created when missing. Anything at its place that isn't a regular file
   * holding a token (a symlink, a damaged file) is replaced. A new token is written in full to a private
   * temporary file and then hard-linked into place, which never replaces an existing file: when two
   * processes create it at once, the first link wins and the other reads that one, never a half-written file.
   */
  private async token(): Promise<string> {
    const path = helperTokenPath(this.runDir);
    const existing = await readTokenFile(path);
    if (existing.token) return existing.token;
    if (existing.present) await rm(path, { force: true });
    const fresh = randomBytes(32).toString("hex");
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, fresh, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await link(tmp, path);
      return fresh;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const winner = await readTokenFile(path);
      if (!winner.token) throw new Error(`the helper token at ${path} is unreadable`);
      return winner.token;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Removes snapshot folders older than a minute, and replies and requests nobody can still be waiting for. */
  private async sweep(): Promise<void> {
    const names = await readdir(this.runDir).catch(() => [] as string[]);
    const t = this.now();
    await Promise.all(
      names.map(async (name) => {
        const isSnap = name.startsWith("snap-");
        const isLeftover = /^(req|res)-[^/]+\.(txt|body|pending|txt\.tmp)$/.test(name);
        if (!isSnap && !isLeftover) return;
        const path = join(this.runDir, name);
        const st = await lstat(path).catch(() => undefined);
        if (!st || t - st.mtimeMs <= (isSnap ? SNAPSHOT_MAX_AGE_MS : STALE_FILE_MS)) return;
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }),
    );
  }
}

/** A token file's token when it is a regular file (not a symlink) holding one; its mode is kept at 0600. */
async function readTokenFile(path: string): Promise<{ present: boolean; token?: string }> {
  const st = await lstat(path).catch(() => undefined);
  if (!st) return { present: false };
  if (!st.isFile()) return { present: true };
  const text = (await readFile(path, "utf8")).trim();
  if (!TOKEN.test(text)) return { present: true };
  if ((st.mode & 0o777) !== 0o600) await chmod(path, 0o600);
  return { present: true, token: text };
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** Line 1 `ok` or `error`, line 2 the code, then the lines (or the error message). */
function parseReply(text: string): HelperReply {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[0] === "ok" && lines.length >= 2) return { ok: true, lines: lines.slice(2) };
  if (lines[0] === "error" && lines.length >= 2) return { ok: false, code: lines[1] || "unknown", message: lines.slice(2).join("\n") };
  return { ok: false, code: "bad-reply", message: `Tropos Messages Helper answered something unreadable: ${JSON.stringify(text.slice(0, 200))}` };
}
