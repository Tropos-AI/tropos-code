// src/gateway/owner-claim.ts — the short window in which setup listens for the owner's first Telegram message. The
// gateway records who wrote (it never approves anyone); the owner confirms one of them on the computer.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OwnerCandidateView } from "../web/admin/api";
import type { TgMessage } from "./telegram/api";

export type { OwnerCandidateView };

export const OWNER_CLAIM_MINUTES = 10;
const MAX_CANDIDATES = 5;

export const ownerClaimPath = (home: string) => join(home, "gateway", "owner-claim.json");

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
  candidates: OwnerCandidateView[];
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
  open(): Promise<void> {
    return this.serial(async () => {
      const now = this.now();
      const file = await this.read();
      const live = file !== null && file.openUntil > now;
      await this.write({
        openUntil: now + OWNER_CLAIM_MINUTES * 60_000,
        windowStart: live ? file.windowStart : Math.floor(now / 1000) * 1000,
        candidates: live ? file.candidates : [],
      });
    });
  }

  async isOpen(): Promise<boolean> {
    const file = await this.read();
    return file !== null && file.openUntil > this.now();
  }

  /** Start of the open window, or null when closed. */
  async windowStart(): Promise<number | null> {
    const file = await this.read();
    return file !== null && file.openUntil > this.now() ? file.windowStart : null;
  }

  /** Only while the window is open and only for a message sent inside it. One entry per sender (the latest wins); the five newest are kept. */
  add(c: OwnerCandidateView): Promise<boolean> {
    return this.serial(async () => {
      const file = await this.read();
      if (!file || file.openUntil <= this.now() || c.at < file.windowStart) return false;
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
    return this.serial(() => rm(ownerClaimPath(this.home), { force: true }));
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => {});
    return next;
  }

  private async read(): Promise<ClaimFile | null> {
    try {
      const raw = JSON.parse(await readFile(ownerClaimPath(this.home), "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null) return null;
      const r = raw as Record<string, unknown>;
      if (typeof r.openUntil !== "number" || typeof r.windowStart !== "number" || !Array.isArray(r.candidates)) return null;
      return { openUntil: r.openUntil, windowStart: r.windowStart, candidates: r.candidates.map(parseCandidate).filter((c): c is OwnerCandidateView => c !== null) };
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
