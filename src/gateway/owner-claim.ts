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
  return { senderId: String(msg.from.id), chatId: msg.chat.id, name, ...(msg.from.username ? { username: msg.from.username } : {}), at: now };
}

interface ClaimFile {
  openUntil: number;
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

  /** Starts the window, or extends it to ten minutes from now; recorded candidates stay. */
  open(): Promise<void> {
    return this.serial(async () => {
      const file = (await this.read()) ?? { openUntil: 0, candidates: [] };
      await this.write({ openUntil: this.now() + OWNER_CLAIM_MINUTES * 60_000, candidates: file.candidates });
    });
  }

  async isOpen(): Promise<boolean> {
    const file = await this.read();
    return file !== null && file.openUntil > this.now();
  }

  /** Only while the window is open. One entry per sender (the latest wins); the five newest are kept. */
  add(c: OwnerCandidateView): Promise<void> {
    return this.serial(async () => {
      const file = await this.read();
      if (!file || file.openUntil <= this.now()) return;
      const kept = file.candidates.filter((x) => x.senderId !== c.senderId);
      kept.push(c);
      await this.write({ openUntil: file.openUntil, candidates: kept.slice(-MAX_CANDIDATES) });
    });
  }

  /** Newest first; empty when closed, expired, missing or unreadable. */
  async candidates(): Promise<OwnerCandidateView[]> {
    const file = await this.read();
    if (!file || file.openUntil <= this.now()) return [];
    return [...file.candidates].reverse();
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
      if (typeof r.openUntil !== "number" || !Array.isArray(r.candidates)) return null;
      return { openUntil: r.openUntil, candidates: r.candidates.map(parseCandidate).filter((c): c is OwnerCandidateView => c !== null) };
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
