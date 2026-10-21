// src/messages/source.ts — read-only chat.db snapshots fetched through the helper, cached briefly, with plain-words errors
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { UserFacingError } from "../gateway/errors";
import { Contacts } from "./contacts";
import { MessagesDb } from "./db";
import { normalizeHandle, sameHandle } from "./handles";
import type { HelperClient, HelperReply } from "./helper/client";

export type MessagesErrorCode = "off" | "no-full-disk-access" | "no-automation" | "not-signed-in" | "helper" | "timeout" | "no-such-chat";

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
  if (reply.code === "eperm") return new MessagesError("no-full-disk-access");
  if (reply.code === "-1743") return new MessagesError("no-automation");
  if (reply.code === "timeout") return new MessagesError("timeout");
  return new MessagesError("helper", reply.message);
}

const BOOK_FILE = "AddressBook-v22.abcddb";

interface Snapshot {
  dir: string;
  db: Database;
  messages: MessagesDb;
  contacts: Contacts;
  takenAt: number;
  users: number;
  retired: boolean;
}

/**
 * The reader's source of data: asks the helper for a copy of chat.db and the address book, opens the copy
 * read-only and reuses it for `cacheMs`. A replaced snapshot's folder is deleted once nobody is reading it.
 */
export class MessagesSource {
  private readonly client: HelperClient;
  private readonly runDir: string;
  private readonly userHome: string;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private current: Snapshot | undefined;
  private pending: Promise<Snapshot> | undefined;
  private lastBook: Contacts | undefined;
  private lastHandles: string[] = [];
  private readonly extraDirs = new Set<string>();

  constructor(o: { client: HelperClient; runDir: string; userHome: string; now?: () => number; cacheMs?: number }) {
    this.client = o.client;
    this.runDir = o.runDir;
    this.userHome = o.userHome;
    this.now = o.now ?? Date.now;
    this.cacheMs = o.cacheMs ?? 5_000;
  }

  /** Runs `fn` on a snapshot no older than the cache time. */
  async with<T>(fn: (db: MessagesDb, contacts: Contacts) => T | Promise<T>): Promise<T> {
    const live = this.current;
    const snap = live && !live.retired && this.now() - live.takenAt < this.cacheMs ? live : await this.take();
    return this.use(snap, fn);
  }

  /** Runs `fn` on a snapshot taken right now (send verification must see the newest rows). */
  async fresh<T>(fn: (db: MessagesDb) => T): Promise<T> {
    return this.use(await this.take(), (db) => fn(db));
  }

  /** The address book of the latest snapshot, if one was taken. */
  lastContacts(): Contacts | undefined {
    return this.lastBook;
  }

  /** The stored spelling of a handle known to the last snapshot or address book that is the same person as `raw`. */
  canonicalHandle(raw: string): string | undefined {
    const known = [...this.lastHandles, ...(this.lastBook?.handles() ?? [])];
    return known.map(normalizeHandle).find((h) => sameHandle(h, raw));
  }

  /** Has the helper copy an attachment out of ~/Library/Messages/Attachments into the run folder. */
  async attachmentCopy(id: number): Promise<{ path: string; mime?: string; name: string }> {
    const found = await this.with((db) => db.attachment(id));
    if (!found) throw new MessagesError("helper", `no attachment ${id}`);
    const allowed = join(resolve(this.userHome), "Library", "Messages", "Attachments") + sep;
    const src = resolve(found.path);
    if (!src.startsWith(allowed)) throw new MessagesError("helper", "that attachment isn't stored in the Messages attachments folder");
    const dir = join(this.runDir, `snap-att-${randomBytes(6).toString("hex")}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.extraDirs.add(dir);
    const dest = join(dir, basename(src));
    const reply = await this.client.request("attachment", [src, dest]);
    if (!reply.ok) {
      rmSync(dir, { recursive: true, force: true });
      this.extraDirs.delete(dir);
      throw errorFromReply(reply);
    }
    return { path: dest, ...(found.mime ? { mime: found.mime } : {}), name: found.name };
  }

  /** Closes the snapshot and deletes every folder this source made. */
  dispose(): void {
    if (this.current) this.retire(this.current);
    this.current = undefined;
    this.lastBook = undefined;
    for (const dir of this.extraDirs) rmSync(dir, { recursive: true, force: true });
    this.extraDirs.clear();
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

  /** One snapshot at a time; callers arriving meanwhile get the same one. */
  private take(): Promise<Snapshot> {
    this.pending ??= this.snapshot().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async snapshot(): Promise<Snapshot> {
    const dir = join(this.runDir, `snap-${randomBytes(6).toString("hex")}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const reply = await this.client.request("snapshot", [dir]);
      if (!reply.ok) throw errorFromReply(reply);
      const chatDb = join(dir, "chat.db");
      if (!existsSync(chatDb)) throw new MessagesError("helper", "the snapshot has no chat.db");
      const contacts = await this.copyContacts(dir);
      const db = new Database(chatDb, { readonly: true });
      const snap: Snapshot = { dir, db, messages: new MessagesDb(db, (h) => contacts.nameOf(h), this.userHome), contacts, takenAt: this.now(), users: 0, retired: false };
      const previous = this.current;
      this.current = snap;
      this.lastBook = contacts;
      this.lastHandles = snap.messages.handles();
      if (previous) this.retire(previous);
      return snap;
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** The address books the helper copied; any trouble just means no names. */
  private async copyContacts(dir: string): Promise<Contacts> {
    try {
      const reply = await this.client.request("contacts", [dir]);
      if (!reply.ok) return Contacts.none();
      return Contacts.open(reply.lines.filter((l) => l.trim()).map((l) => join(l.trim(), BOOK_FILE)));
    } catch {
      return Contacts.none();
    }
  }
}
