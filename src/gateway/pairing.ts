// src/gateway/pairing.ts — deny-by-default allowlist of senders, with hashed one-time pairing codes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { troposHome } from "../paths";
import type { PairedSender, Pairing, PairingChallenge } from "./types";

const HOUR = 3_600_000;
const CODE_LENGTH = 8;
const MAX_CODES_PER_HOUR = 5;
const MAX_FAILURES_PER_HOUR = 5;
/** No 0/O/1/I/L. 31 symbols. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ACCEPT_BELOW = 248; // 31 * 8: bytes at or above this are rejected to avoid modulo bias

interface PendingEntry {
  channel: string;
  senderId: string;
  hash: string;
  issuedAt: number;
  expiresAt: number;
}
interface OwnerEntry {
  channel: string;
  senderId: string;
  since: number;
}
interface State {
  version: 2;
  salt: string;
  owner?: OwnerEntry;
  approved: PairedSender[];
  pending: PendingEntry[];
  /** Every code issued (for the per-sender rolling-hour limit). */
  issued: { channel: string; senderId: string; at: number }[];
  /** Failed approve() attempts (for the per-channel lockout). */
  failures: { channel: string; at: number }[];
}

export interface FilePairingOptions {
  path?: string;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];

export class FilePairing implements Pairing {
  private readonly path: string;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Uint8Array;
  private queue: Promise<unknown> = Promise.resolve();
  /** Plaintext of codes this instance issued, so a repeat challenge can show the same code. Never persisted. */
  private readonly shown = new Map<string, string>();

  constructor(opts: FilePairingOptions = {}) {
    this.path = opts.path ?? join(troposHome(), "gateway", "pairing.json");
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? ((n) => new Uint8Array(randomBytes(n)));
  }

  isApproved(channel: string, senderId: string): Promise<boolean> {
    return this.run(async (s) => {
      return s.approved.some((a) => a.channel === channel && a.senderId === senderId);
    }, false);
  }

  owner(): Promise<{ channel: string; senderId: string } | null> {
    return this.run(async (s) => (s.owner ? { channel: s.owner.channel, senderId: s.owner.senderId } : null), false);
  }

  setOwner(channel: string, senderId: string): Promise<void> {
    return this.run(async (s) => {
      if (!s.approved.some((a) => a.channel === channel && a.senderId === senderId)) throw new Error("only an approved sender can be the owner");
      s.owner = { channel, senderId, since: this.now() };
    });
  }

  isOwner(channel: string, senderId: string): Promise<boolean> {
    return this.run(async (s) => s.owner?.channel === channel && s.owner.senderId === senderId, false);
  }

  /** Throws if the sender is already approved (the adapter should not be challenging them). */
  challenge(channel: string, senderId: string): Promise<PairingChallenge> {
    return this.run(async (s) => {
      const now = this.now();
      if (s.approved.some((a) => a.channel === channel && a.senderId === senderId)) {
        throw new Error("sender is already approved");
      }
      const mine = (e: { channel: string; senderId: string }) => e.channel === channel && e.senderId === senderId;
      const key = `${channel}\u0000${senderId}`;
      const live = s.pending.find((p) => mine(p) && p.expiresAt > now);
      const cached = this.shown.get(key);
      if (live && cached && this.hash(s, channel, cached) === live.hash) {
        return { kind: "code", code: cached, expiresAt: live.expiresAt };
      }
      // A valid code we can't show again (issued by another process or before a restart) is replaced.
      if (s.issued.filter((i) => mine(i) && i.at > now - HOUR).length >= MAX_CODES_PER_HOUR) return { kind: "limited" };
      s.pending = s.pending.filter((p) => !mine(p));
      let code: string;
      let hash: string;
      do {
        code = this.newCode();
        hash = this.hash(s, channel, code);
      } while (s.pending.some((p) => p.channel === channel && p.hash === hash));
      const expiresAt = now + HOUR;
      s.pending.push({ channel, senderId, hash, issuedAt: now, expiresAt });
      s.issued.push({ channel, senderId, at: now });
      this.shown.set(key, code);
      return { kind: "code", code, expiresAt };
    });
  }

  approve(channel: string, code: string): Promise<{ ok: true; senderId: string } | { ok: false; reason: string }> {
    return this.run(async (s) => {
      const now = this.now();
      const recentFailures = s.failures.filter((f) => f.channel === channel && f.at > now - HOUR);
      if (recentFailures.length >= MAX_FAILURES_PER_HOUR) {
        return { ok: false as const, reason: "too many failed attempts; try again later" };
      }
      const given = Buffer.from(this.hash(s, channel, normalize(code)), "hex");
      // Compare against every pending hash of the channel, without stopping at the first match.
      let match: PendingEntry | undefined;
      for (const p of s.pending) {
        if (p.channel !== channel) continue;
        const eq = timingSafeEqual(given, Buffer.from(p.hash, "hex"));
        if (eq && !match) match = p;
      }
      if (match && match.expiresAt > now) {
        const { senderId } = match;
        s.pending = s.pending.filter((p) => !(p.channel === channel && p.senderId === senderId));
        // The first person ever approved is the owner; later ones are guests until the owner says otherwise.
        const first = !s.owner && s.approved.every((a) => a.channel === channel && a.senderId === senderId);
        s.approved = s.approved.filter((a) => !(a.channel === channel && a.senderId === senderId));
        s.approved.push({ channel, senderId, approvedAt: now });
        if (first) s.owner = { channel, senderId, since: now };
        return { ok: true as const, senderId };
      }
      s.failures.push({ channel, at: now });
      return { ok: false as const, reason: match ? "code expired" : "unknown code" };
    });
  }

  list(): Promise<PairedSender[]> {
    return this.run(async (s) => s.approved.map((a) => ({ ...a })), false);
  }

  /** Codes handed out and still valid, without the sender or the code: the owner sees that someone asked, not who. */
  pending(): Promise<{ channel: string; requestedAt: number; expiresAt: number }[]> {
    return this.run(async (s) => {
      const now = this.now();
      return s.pending.filter((p) => p.expiresAt > now).map((p) => ({ channel: p.channel, requestedAt: p.issuedAt, expiresAt: p.expiresAt }));
    }, false);
  }

  revoke(channel: string, senderId: string): Promise<boolean> {
    return this.run(async (s) => {
      const before = s.approved.length + s.pending.length;
      s.approved = s.approved.filter((a) => !(a.channel === channel && a.senderId === senderId));
      s.pending = s.pending.filter((p) => !(p.channel === channel && p.senderId === senderId));
      this.shown.delete(`${channel}\u0000${senderId}`);
      if (s.owner?.channel === channel && s.owner.senderId === senderId) delete s.owner;
      return s.approved.length + s.pending.length < before;
    });
  }

  // --- internals ---

  /** Serialises operations; re-reads the file first. Mutating operations write back (after pruning) when the state changed. */
  private run<T>(op: (s: State) => Promise<T>, mutates = true): Promise<T> {
    const next = this.queue.then(async () => {
      const { state: s, migrated } = await this.load();
      const before = JSON.stringify(s);
      const result = await op(s);
      if (mutates) {
        this.prune(s);
        if (JSON.stringify(s) !== before) await this.save(s);
      } else if (migrated) {
        // A version-1 file is rewritten as version 2 on first read, so the owner migration never runs twice.
        await this.save(s);
      }
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private prune(s: State): void {
    const cutoff = this.now() - HOUR;
    // Expired codes linger for an hour so approve() can say "expired" rather than "unknown".
    s.pending = s.pending.filter((p) => p.expiresAt > cutoff);
    s.issued = s.issued.filter((i) => i.at > cutoff);
    s.failures = s.failures.filter((f) => f.at > cutoff);
  }

  private hash(s: State, channel: string, code: string): string {
    return createHash("sha256").update(`${s.salt}\u0000${channel}\u0000${code}`).digest("hex");
  }

  private newCode(): string {
    let out = "";
    while (out.length < CODE_LENGTH) {
      for (const b of this.random(CODE_LENGTH * 2)) {
        if (b < ACCEPT_BELOW && out.length < CODE_LENGTH) out += ALPHABET[b % ALPHABET.length];
      }
    }
    return out;
  }

  private fresh(): State {
    return { version: 2, salt: Buffer.from(this.random(16)).toString("hex"), approved: [], pending: [], issued: [], failures: [] };
  }

  private async load(): Promise<{ state: State; migrated: boolean }> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return { state: this.fresh(), migrated: false };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { state: this.fresh(), migrated: false };
    const r = raw as Record<string, unknown>;
    if (!isStr(r.salt) || r.salt.length < 16) return { state: this.fresh(), migrated: false };
    const s: State = { version: 2, salt: r.salt, approved: [], pending: [], issued: [], failures: [] };
    for (const a of arr(r.approved)) {
      if (isStr(a.channel) && isStr(a.senderId) && isNum(a.approvedAt)) s.approved.push({ channel: a.channel, senderId: a.senderId, approvedAt: a.approvedAt });
    }
    for (const p of arr(r.pending)) {
      if (isStr(p.channel) && isStr(p.senderId) && isStr(p.hash) && /^[0-9a-f]{64}$/.test(p.hash) && isNum(p.issuedAt) && isNum(p.expiresAt)) {
        s.pending.push({ channel: p.channel, senderId: p.senderId, hash: p.hash, issuedAt: p.issuedAt, expiresAt: p.expiresAt });
      }
    }
    for (const i of arr(r.issued)) {
      if (isStr(i.channel) && isStr(i.senderId) && isNum(i.at)) s.issued.push({ channel: i.channel, senderId: i.senderId, at: i.at });
    }
    for (const f of arr(r.failures)) {
      if (isStr(f.channel) && isNum(f.at)) s.failures.push({ channel: f.channel, at: f.at });
    }
    const o = r.owner;
    if (typeof o === "object" && o !== null && !Array.isArray(o)) {
      const { channel, senderId, since } = o as Record<string, unknown>;
      if (isStr(channel) && isStr(senderId) && isNum(since) && s.approved.some((a) => a.channel === channel && a.senderId === senderId)) {
        s.owner = { channel, senderId, since };
      }
    }
    if (r.version === 1) {
      // Only a version-1 file is migrated: a lone sender was the only person who could ever have been the owner.
      if (s.approved.length === 1) s.owner = { channel: s.approved[0].channel, senderId: s.approved[0].senderId, since: this.now() };
      return { state: s, migrated: true };
    }
    return { state: s, migrated: false };
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

function normalize(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/** The owner's chat key (`<channel>:<senderId>`; a Telegram private chat's id is the sender's id), or undefined with no owner. */
export async function ownerChatKey(pairing: Pick<Pairing, "owner">): Promise<string | undefined> {
  const o = await pairing.owner();
  return o ? `${o.channel}:${o.senderId}` : undefined;
}
