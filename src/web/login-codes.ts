// src/web/login-codes.ts — short-lived ways to log a browser in: a one-time key (link) or a 6-digit code (typed on a phone).
// Shared by two processes (the CLI issues, the gateway redeems), so the state lives in a file; only hashes are stored.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ONE_TIME_TTL_MS = 120_000;
export const CODE_TTL_MS = 600_000;
export const CODE_MAX_TRIES = 5;
export const GLOBAL_MAX_FAILURES = 20;
export const GLOBAL_WINDOW_MS = 600_000;
const ACCEPT_BELOW = 250; // bytes at or above this are rejected, so the digits have no modulo bias
const CODE_LENGTH = 6;

interface Entry {
  kind: "once" | "code";
  hash: string;
  expiresAt: number;
  tries: number;
}
interface State {
  version: 1;
  salt: string;
  entries: Entry[];
  /** Times of failed redeems, for the limit that holds across all codes. */
  failures: number[];
}

export interface LoginCodesOptions {
  path: string;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
}

export const loginCodesPath = (home: string): string => join(home, "gateway", "login-codes.json");

/** The file-backed store the CLI issues from and the gateway redeems against. */
export const loginCodesFor = (home: string): LoginCodes => new LoginCodes({ path: loginCodesPath(home) });

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export class LoginCodes {
  private readonly path: string;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Uint8Array;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: LoginCodesOptions) {
    this.path = opts.path;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? ((n) => new Uint8Array(randomBytes(n)));
  }

  /** A 43-character base64url key for a login link; valid for 2 minutes, once. */
  issueOneTime(): Promise<string> {
    return this.run((s) => {
      const value = Buffer.from(this.random(32)).toString("base64url");
      s.entries.push({ kind: "once", hash: this.hash(s, value), expiresAt: this.now() + ONE_TIME_TTL_MS, tries: 0 });
      return value;
    });
  }

  /** Six digits; valid for 10 minutes, once, and dies after 5 wrong tries anywhere. */
  issueCode(): Promise<string> {
    return this.run((s) => {
      let value: string;
      let hash: string;
      do {
        value = this.newDigits();
        hash = this.hash(s, value);
      } while (s.entries.some((e) => e.kind === "code" && e.hash === hash));
      s.entries.push({ kind: "code", hash, expiresAt: this.now() + CODE_TTL_MS, tries: 0 });
      return value;
    });
  }

  /** True when the value was a live key or code; it is then spent. */
  redeem(value: string): Promise<boolean> {
    return this.run((s) => {
      const now = this.now();
      if (this.failuresIn(s) >= GLOBAL_MAX_FAILURES) return false;
      // Only a 6-digit code is normalised: a one-time key is base64url and may itself contain '-'.
      const isCode = /^\d{3}[- ]?\d{3}$/.test(value);
      const given = Buffer.from(this.hash(s, isCode ? value.replace(/[- ]/g, "") : value), "hex");
      const kind = isCode ? "code" : "once";
      // Every live entry of the kind is compared, without stopping at the first match.
      let match: Entry | undefined;
      for (const e of s.entries) {
        if (e.kind !== kind || e.expiresAt <= now) continue;
        if (timingSafeEqual(given, Buffer.from(e.hash, "hex")) && !match) match = e;
      }
      if (match) {
        s.entries = s.entries.filter((e) => e !== match);
        return true;
      }
      s.failures.push(now);
      if (isCode) {
        for (const e of s.entries) if (e.kind === "code") e.tries++;
        s.entries = s.entries.filter((e) => e.kind !== "code" || e.tries < CODE_MAX_TRIES);
      }
      return false;
    });
  }

  /** The global failure limit is in force, so the login screen can say "wait". */
  locked(): Promise<boolean> {
    return this.run((s) => this.failuresIn(s) >= GLOBAL_MAX_FAILURES);
  }

  // --- internals ---

  private failuresIn(s: State): number {
    return s.failures.filter((f) => f > this.now() - GLOBAL_WINDOW_MS).length;
  }

  /** Serialises operations; re-reads the file first, drops what has expired, writes back when anything changed. */
  private run<T>(op: (s: State) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const s = await this.load();
      const now = this.now();
      s.entries = s.entries.filter((e) => e.expiresAt > now);
      s.failures = s.failures.filter((f) => f > now - GLOBAL_WINDOW_MS);
      const before = JSON.stringify(s);
      const result = op(s);
      if (JSON.stringify(s) !== before) await this.save(s);
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private hash(s: State, value: string): string {
    return createHash("sha256").update(s.salt + value).digest("hex");
  }

  private newDigits(): string {
    let out = "";
    while (out.length < CODE_LENGTH) {
      for (const b of this.random(CODE_LENGTH * 2)) {
        if (b < ACCEPT_BELOW && out.length < CODE_LENGTH) out += String(b % 10);
      }
    }
    return out;
  }

  private fresh(): State {
    return { version: 1, salt: Buffer.from(this.random(16)).toString("hex"), entries: [], failures: [] };
  }

  private async load(): Promise<State> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return this.fresh();
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return this.fresh();
    const r = raw as Record<string, unknown>;
    if (typeof r.salt !== "string" || r.salt.length < 16) return this.fresh();
    const s: State = { version: 1, salt: r.salt, entries: [], failures: [] };
    if (Array.isArray(r.entries)) {
      for (const e of r.entries) {
        if (typeof e !== "object" || e === null) continue;
        const x = e as Record<string, unknown>;
        if ((x.kind === "once" || x.kind === "code") && typeof x.hash === "string" && /^[0-9a-f]{64}$/.test(x.hash) && isNum(x.expiresAt) && isNum(x.tries)) {
          s.entries.push({ kind: x.kind, hash: x.hash, expiresAt: x.expiresAt, tries: x.tries });
        }
      }
    }
    if (Array.isArray(r.failures)) s.failures = r.failures.filter(isNum);
    return s;
  }

  /** Atomic: private temp file, then rename over the target. */
  private async save(s: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
}
