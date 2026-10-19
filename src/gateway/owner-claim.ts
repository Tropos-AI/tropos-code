// src/gateway/owner-claim.ts — the window in which setup listens for the owner's first Telegram message. The dashboard
// opens a short one: the gateway records who wrote and the owner confirms one of them on the computer. `tcode onboard`
// opens an automatic one, so nobody has to wait at the terminal: the link's secret is the proof, and the gateway makes
// whoever sends it the owner (only while there is none).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "../web/file-lock";
import type { OwnerCandidateView } from "../web/admin/api";
import type { TgMessage } from "./telegram/api";

export type { OwnerCandidateView };

export const OWNER_CLAIM_MINUTES = 10;
/** An automatic window waits for the tap as long as Telegram keeps a message for the bot. */
export const OWNER_CLAIM_AUTO_HOURS = 24;
export const OWNER_GREETING = "You're connected. This chat now talks to Tropos on your computer; send me anything.";
const MAX_CANDIDATES = 5;

export const ownerClaimPath = (home: string) => join(home, "gateway", "owner-claim.json");

/** The deep link the owner opens (or scans) on their phone: Telegram sends the bot `/start <nonce>`. */
export const ownerClaimLink = (botUsername: string, nonce: string) => `https://t.me/${botUsername}?start=${nonce}`;

/** Exactly `/start <nonce>` (what the link sends) or the bare nonce. Anything else proves nothing. */
export function claimProof(text: string | undefined, nonce: string): boolean {
  if (text === undefined) return false;
  const given = Buffer.from(text.trim());
  return [`/start ${nonce}`, nonce].some((ok) => given.length === Buffer.byteLength(ok) && timingSafeEqual(given, Buffer.from(ok)));
}

/** Null for bots, groups and messages without a sender: only a person writing privately can be the owner. */
export function candidateFrom(msg: TgMessage, now: number): OwnerCandidateView | null {
  if (!msg.from || msg.from.is_bot || msg.chat.type !== "private") return null;
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");
  // The message's own date, so a delayed or replayed message cannot pass for one written inside the window.
  const at = msg.date !== undefined ? msg.date * 1000 : now;
  return { senderId: String(msg.from.id), chatId: msg.chat.id, name, ...(msg.from.username ? { username: msg.from.username } : {}), at };
}

interface ClaimFile {
  openUntil: number;
  /** When this window began (whole seconds, like Telegram's dates). Candidates older than this don't count. */
  windowStart: number;
  /** Which window this is; a new window never inherits the old one's candidates or secret. */
  generation: string;
  /** The secret in the link. Only a sender who sends it is recorded. */
  nonce: string;
  candidates: OwnerCandidateView[];
  /** The gateway confirms the first sender with the secret itself (opened by `tcode onboard`). */
  auto?: boolean;
}

function parseCandidate(v: unknown): OwnerCandidateView | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.senderId !== "string" || typeof o.chatId !== "number" || typeof o.name !== "string" || typeof o.at !== "number") return null;
  return { senderId: o.senderId, chatId: o.chatId, name: o.name, ...(typeof o.username === "string" ? { username: o.username } : {}), at: o.at };
}

export class OwnerClaimStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly home: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Starts a fresh window, or extends the one that is open (keeping its start and candidates). A window that has
   * expired is never revived: whatever it recorded is dropped.
   */
  open(opts: { auto?: boolean } = {}): Promise<void> {
    return this.locked(async () => {
      const now = this.now();
      const file = await this.read();
      const live = file !== null && file.openUntil > now;
      const auto = opts.auto === true || (live && file.auto === true);
      await this.write({
        openUntil: Math.max(live ? file.openUntil : 0, now + (auto ? OWNER_CLAIM_AUTO_HOURS * 3_600_000 : OWNER_CLAIM_MINUTES * 60_000)),
        ...(auto ? { auto } : {}),
        windowStart: live ? file.windowStart : Math.floor(now / 1000) * 1000,
        generation: live ? file.generation : randomBytes(8).toString("hex"),
        nonce: live ? file.nonce : randomBytes(9).toString("base64url"),
        candidates: live ? file.candidates : [],
      });
    });
  }

  async isOpen(): Promise<boolean> {
    const file = await this.read();
    return file !== null && file.openUntil > this.now();
  }

  /** True while an automatic window is open (see the top of this file). */
  async isAuto(): Promise<boolean> {
    const file = await this.read();
    return file !== null && file.openUntil > this.now() && file.auto === true;
  }

  /** Start of the open window, or null when closed. */
  async windowStart(): Promise<number | null> {
    const file = await this.read();
    return file !== null && file.openUntil > this.now() ? file.windowStart : null;
  }

  /** The open window's secret, or null when closed. */
  async nonce(): Promise<string | null> {
    const file = await this.read();
    return file !== null && file.openUntil > this.now() ? file.nonce : null;
  }

  /**
   * Records a sender, only while the window is open, only for a message sent inside it, and only if the message text
   * proves the sender has the link (`proof`). One entry per sender (the latest wins); the five newest are kept.
   * Read and write happen under one lock, so a window closed meanwhile is never written to.
   */
  add(c: OwnerCandidateView, proof: string | undefined): Promise<boolean> {
    return this.locked(async () => {
      const file = await this.read();
      if (!file || file.openUntil <= this.now() || c.at < file.windowStart || !claimProof(proof, file.nonce)) return false;
      const kept = file.candidates.filter((x) => x.senderId !== c.senderId);
      kept.push(c);
      await this.write({ ...file, candidates: kept.slice(-MAX_CANDIDATES) });
      return true;
    });
  }

  /** Newest first; empty when closed, expired, missing or unreadable. */
  async candidates(): Promise<OwnerCandidateView[]> {
    const file = await this.read();
    if (!file || file.openUntil <= this.now()) return [];
    return file.candidates.filter((c) => c.at >= file.windowStart).reverse();
  }

  close(): Promise<void> {
    return this.locked(() => rm(ownerClaimPath(this.home), { force: true }));
  }

  /** In this process in order, and across processes (the gateway writes this file too) under the file lock. */
  private locked<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => withFileLock(ownerClaimPath(this.home), op));
    this.queue = next.catch(() => {});
    return next;
  }

  private async read(): Promise<ClaimFile | null> {
    try {
      const raw = JSON.parse(await readFile(ownerClaimPath(this.home), "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null) return null;
      const r = raw as Record<string, unknown>;
      if (typeof r.openUntil !== "number" || typeof r.windowStart !== "number" || typeof r.generation !== "string" || typeof r.nonce !== "string" || !Array.isArray(r.candidates)) return null;
      return {
        openUntil: r.openUntil,
        windowStart: r.windowStart,
        generation: r.generation,
        nonce: r.nonce,
        candidates: r.candidates.map(parseCandidate).filter((c): c is OwnerCandidateView => c !== null),
        ...(r.auto === true ? { auto: true } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Atomic, private: another process (the gateway) reads this while setup writes it. */
  private async write(file: ClaimFile): Promise<void> {
    const path = ownerClaimPath(this.home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }
}
