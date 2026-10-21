// src/messages/source.ts — read-only chat.db snapshots fetched through the helper, cached briefly, with plain-words errors
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { UserFacingError } from "../gateway/errors";
import { Contacts } from "./contacts";
import { MessagesDb } from "./db";
import { normalizeHandle, sameHandle } from "./handles";
import type { HelperClient, HelperReply } from "./helper/client";

export type MessagesErrorCode = "off" | "no-full-disk-access" | "no-automation" | "not-signed-in" | "no-history" | "helper" | "timeout" | "no-such-chat";

const DONT_RETRY = "Don't retry until the user says it's fixed.";

const TEXTS: Record<Exclude<MessagesErrorCode, "helper">, string> = {
  off: `Messages access is switched off. Ask the user to turn it on in Tropos settings. ${DONT_RETRY}`,
  "no-full-disk-access":
    "Tropos doesn't have Full Disk Access yet, so it can't read Messages. To grant it: open System Settings, go to Privacy & Security, then Full Disk Access, and switch on \"Tropos Messages Helper\". " +
    DONT_RETRY,
  "no-automation":
    "macOS hasn't allowed Tropos to control Messages. To allow it: open System Settings, go to Privacy & Security, then Automation, and switch on Messages under \"Tropos Messages Helper\". " +
    DONT_RETRY,
  "not-signed-in": `Messages isn't signed in to iMessage on this Mac. Ask the user to open Messages and sign in. ${DONT_RETRY}`,
  "no-history": `Messages has no history on this Mac yet. Ask the user to open Messages and sign in. ${DONT_RETRY}`,
  timeout: "The Messages helper didn't answer in time. Messages may be busy or not running; try once more shortly.",
  "no-such-chat": "No such chat; use Messages action chats to find it.",
};

/** A Messages problem written for the user and the model, with a code the tools can branch on. */
export class MessagesError extends UserFacingError {
  constructor(
    readonly code: MessagesErrorCode,
    detail?: string,
  ) {
    super(code === "helper" ? `The Messages helper failed${detail ? `: ${detail}` : "."}` : TEXTS[code]);
  }
}

/** Turns a helper error reply into the matching MessagesError. */
export function errorFromReply(reply: Extract<HelperReply, { ok: false }>): MessagesError {
  if (reply.code === "eperm" || reply.code === "fda=no" || reply.message.trim() === "fda=no") return new MessagesError("no-full-disk-access");
  if (reply.code === "-1743") return new MessagesError("no-automation");
  if (reply.code === "no-account") return new MessagesError("not-signed-in");
  if (reply.code === "no-history") return new MessagesError("no-history");
  if (reply.code === "timeout") return new MessagesError("timeout");
  return new MessagesError("helper", reply.message);
}

const BOOK_FILE = "AddressBook-v22.abcddb";
/** How long one copy of chat.db answers reads: each new copy is a whole chat.db, so they are not taken often. */
export const CACHE_MS = 30_000;

/** True when `path` (already resolved) lies strictly inside `dir`. */
function inside(dir: string, path: string): boolean {
  return path.startsWith(resolve(dir) + sep);
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface Snapshot {
  dir: string;
  db: Database;
  messages: MessagesDb;
  contacts: Contacts;
  takenAt: number;
  users: number;
  retired: boolean;
}

/** Calls `fn` after `ms` without keeping the process alive; returns what cancels it. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

const unrefTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/**
 * The reader's source of data: asks the helper for a copy of chat.db and the address book, opens the copy
 * read-only and reuses it for `cacheMs`. The copies sit outside what Full Disk Access protects, so none is kept
 * longer than needed: a replaced snapshot's folder is deleted once nobody is reading it, and the current one is
 * retired the same way once it is older than `cacheMs` (on a timer that never keeps the process alive).
 */
export class MessagesSource {
  private readonly client: HelperClient;
  private readonly runDir: string;
  private readonly userHome: string;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private current: Snapshot | undefined;
  private pending: Promise<Snapshot> | undefined;
  /** Position in call order at which `pending` started; `fresh` joins only a snapshot that started after it was called. */
  private pendingSeq = 0;
  private seq = 0;
  private disposed = false;
  private lastBook: Contacts | undefined;
  private lastHandles: string[] = [];
  private readonly extraDirs = new Set<string>();
  private readonly setTimer: SetTimer;
  private cancelExpiry: (() => void) | undefined;

  constructor(o: { client: HelperClient; runDir: string; userHome: string; now?: () => number; cacheMs?: number; setTimer?: SetTimer }) {
    this.client = o.client;
    this.runDir = o.runDir;
    this.userHome = o.userHome;
    this.now = o.now ?? Date.now;
    this.cacheMs = o.cacheMs ?? CACHE_MS;
    this.setTimer = o.setTimer ?? unrefTimer;
  }

  /** Runs `fn` on a snapshot no older than the cache time. */
  async with<T>(fn: (db: MessagesDb, contacts: Contacts) => T | Promise<T>): Promise<T> {
    this.assertOpen();
    this.seq++;
    const live = this.current;
    const snap = live && !live.retired && this.now() - live.takenAt < this.cacheMs ? live : await this.take();
    return this.use(snap, fn);
  }

  /** Runs `fn` on a snapshot taken right now (send verification must see the newest rows). */
  async fresh<T>(fn: (db: MessagesDb) => T): Promise<T> {
    this.assertOpen();
    const mine = ++this.seq;
    // A snapshot already under way began before this call, so it may predate the caller's send; wait it out.
    while (this.pending && this.pendingSeq < mine) await this.pending.catch(() => undefined);
    return this.use(await this.take(), (db) => fn(db));
  }

  /** The address book of the latest snapshot, if one was taken. */
  lastContacts(): Contacts | undefined {
    return this.lastBook;
  }

  /**
   * The stored spelling of a handle known to the last snapshot or address book that is the same person as `raw`;
   * undefined when none is, or when a bare number matches more than one (two countries' numbers ending alike), so
   * the caller never picks one of two people on a guess.
   */
  canonicalHandle(raw: string): string | undefined {
    const known = [...new Set([...this.lastHandles, ...(this.lastBook?.handles() ?? [])].map(normalizeHandle))];
    const own = normalizeHandle(raw);
    if (known.includes(own)) return own;
    const matches = known.filter((h) => sameHandle(h, raw));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Has the helper copy an attachment out of ~/Library/Messages/Attachments into the run folder. */
  async attachmentCopy(id: number): Promise<{ path: string; mime?: string; name: string }> {
    const found = await this.with((db) => db.attachment(id));
    this.assertOpen();
    if (!found) throw new MessagesError("helper", `no attachment ${id}`);
    const allowed = join(resolve(this.userHome), "Library", "Messages", "Attachments") + sep;
    const src = resolve(found.path);
    if (!src.startsWith(allowed)) throw new MessagesError("helper", "that attachment isn't stored in the Messages attachments folder");
    const dir = join(this.runDir, `snap-att-${randomBytes(6).toString("hex")}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.extraDirs.add(dir);
    const discard = () => {
      rmSync(dir, { recursive: true, force: true });
      this.extraDirs.delete(dir);
    };
    let reply: HelperReply;
    try {
      reply = await this.client.request("attachment", [src, dir]);
    } catch (err) {
      discard();
      throw err;
    }
    if (!reply.ok) {
      discard();
      throw errorFromReply(reply);
    }
    const copied = reply.lines[0] ? resolve(reply.lines[0]) : "";
    if (this.disposed || !inside(dir, copied) || !existsSync(copied)) {
      discard();
      throw new MessagesError("helper", this.disposed ? "Messages was shut down" : "the helper returned an unexpected attachment path");
    }
    return { path: copied, ...(found.mime ? { mime: found.mime } : {}), name: found.name };
  }

  /** Deletes an attachment copy's folder once its reader is done with it. */
  releaseAttachment(path: string): void {
    const dir = resolve(path, "..");
    if (!this.extraDirs.has(dir)) return;
    rmSync(dir, { recursive: true, force: true });
    this.extraDirs.delete(dir);
  }

  /** Closes the snapshot and deletes every folder this source made. */
  dispose(): void {
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    if (this.current) this.retire(this.current);
    this.current = undefined;
    this.lastBook = undefined;
    this.lastHandles = [];
    this.disposed = true;
    for (const dir of this.extraDirs) rmSync(dir, { recursive: true, force: true });
    this.extraDirs.clear();
  }

  private assertOpen(): void {
    if (this.disposed) throw new MessagesError("helper", "Messages was shut down");
  }

  private async use<T>(snap: Snapshot, fn: (db: MessagesDb, contacts: Contacts) => T | Promise<T>): Promise<T> {
    snap.users++;
    try {
      return await fn(snap.messages, snap.contacts);
    } finally {
      snap.users--;
      this.sweep(snap);
    }
  }

  private retire(snap: Snapshot): void {
    snap.retired = true;
    this.sweep(snap);
  }

  /** Deletes a retired snapshot's folder once no reader is left on it. */
  private sweep(snap: Snapshot): void {
    if (!snap.retired || snap.users > 0 || !existsSync(snap.dir)) return;
    try {
      snap.db.close();
    } catch {
      // Already closed.
    }
    rmSync(snap.dir, { recursive: true, force: true });
  }

  /** Retires `snap` once it is older than the cache time; a newer snapshot replaces the timer. */
  private expireLater(snap: Snapshot): void {
    this.cancelExpiry?.();
    const wait = Math.max(0, snap.takenAt + this.cacheMs - this.now());
    this.cancelExpiry = this.setTimer(() => {
      this.cancelExpiry = undefined;
      if (this.current !== snap) return;
      // A timer that fired early (clock skew) waits out the rest.
      if (this.now() - snap.takenAt < this.cacheMs) return this.expireLater(snap);
      this.current = undefined;
      this.retire(snap);
    }, wait);
  }

  /** One snapshot at a time; callers arriving meanwhile get the same one. */
  private take(): Promise<Snapshot> {
    if (!this.pending) {
      this.pendingSeq = ++this.seq;
      this.pending = this.snapshot().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  private async snapshot(): Promise<Snapshot> {
    const dir = join(this.runDir, `snap-${randomBytes(6).toString("hex")}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let db: Database | undefined;
    try {
      const reply = await this.client.request("snapshot", [dir]);
      if (!reply.ok) throw errorFromReply(reply);
      const chatDb = join(dir, "chat.db");
      if (!existsSync(chatDb)) throw new MessagesError("helper", "the snapshot has no chat.db");
      const contacts = await this.copyContacts(dir);
      if (this.disposed) throw new MessagesError("helper", "Messages was shut down");
      db = new Database(chatDb, { readonly: true });
      const snap: Snapshot = { dir, db, messages: new MessagesDb(db, (h) => contacts.nameOf(h), this.userHome), contacts, takenAt: this.now(), users: 0, retired: false };
      const handles = snap.messages.handles();
      if (this.disposed) throw new MessagesError("helper", "Messages was shut down");
      const previous = this.current;
      this.current = snap;
      this.lastBook = contacts;
      this.lastHandles = handles;
      if (previous) this.retire(previous);
      this.expireLater(snap);
      return snap;
    } catch (err) {
      try {
        db?.close();
      } catch {
        // Already closed.
      }
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** The address books the helper copied; any trouble just means no names. */
  private async copyContacts(dir: string): Promise<Contacts> {
    try {
      const reply = await this.client.request("contacts", [dir]);
      if (!reply.ok) return Contacts.none();
      // The helper lists files relative to the folder; anything resolving outside it is ignored.
      const files = reply.lines
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => resolve(dir, l))
        .filter((p) => inside(dir, p))
        .map((p) => (isFolder(p) ? join(p, BOOK_FILE) : p));
      return Contacts.open(files);
    } catch {
      return Contacts.none();
    }
  }
}
