// src/messages/db.ts — reads chats, messages, search and activity from an opened chat.db snapshot
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { basename } from "node:path";
import { decodeAttributedBody } from "./attributed-body";
import { appleToUnixMs, normalizeHandle, sameHandle } from "./handles";

export interface Participant { handle: string; name?: string }
export interface ChatSummary { id: string; name: string; participants: Participant[]; service: string; isGroup: boolean; lastAt?: number; unread: number }
export interface AttachmentRef { id: number; name: string; mime?: string; bytes?: number }
export interface Message { guid: string; at: number; fromMe: boolean; sender?: Participant; text: string; attachments: AttachmentRef[]; replyTo?: string; reactions: string[] }
export interface SearchHit { chat: ChatSummary; message: Message }
export interface ActivityRow { chat: ChatSummary; received: number; sent: number; last?: Message }

const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"];
const TARGET_PREFIX = /^(p:\d+\/|bp:)/;
/** Message date as Unix milliseconds, computed exactly as appleToUnixMs does so cursors compare on the value callers see. */
const DATE_MS = "CAST(ROUND(((CASE WHEN m.date > 1e12 THEN m.date / 1e9 ELSE m.date END) + 978307200) * 1000) AS INTEGER)";

interface MessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  body: Uint8Array | null;
  handle: string | null;
  fromMe: number;
  date: number;
  reply: string | null;
  chatGuid: string;
  chatRowid: number;
}
interface ChatRow { rowid: number; guid: string; display: string | null; ident: string | null; service: string | null; style: number | null }
type Reactions = Map<string, string[]>;

/** Read-only view of a chat.db copy; every query adapts to the columns this macOS version has. */
export class MessagesDb {
  private readonly columns: Set<string>;
  /** SQL condition that drops tapback rows; always true on schemas without tapbacks. */
  private readonly notReaction: string;

  constructor(
    private readonly db: Database,
    private readonly names: (handle: string) => string | undefined = () => undefined,
    private readonly home: string = homedir(),
  ) {
    const info = db.query("PRAGMA table_info(message)").all() as Array<{ name: string }>;
    this.columns = new Set(info.map((c) => c.name));
    this.notReaction = this.columns.has("associated_message_type") ? "COALESCE(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3999" : "1 = 1";
  }

  /** Every handle stored in the database, normalized and without repeats. */
  handles(): string[] {
    const rows = this.db.query("SELECT id FROM handle WHERE id IS NOT NULL").all() as Array<{ id: string }>;
    return [...new Set(rows.map((r) => normalizeHandle(r.id)))];
  }

  /** Chats newest first; the query matches name, contact name or handle. */
  chats(opts: { query?: string; limit: number }): ChatSummary[] {
    let all = [...this.allChats().values()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    const needle = opts.query?.trim().toLowerCase();
    if (needle) {
      const compact = normalizeHandle(needle);
      all = all.filter(
        (chat) =>
          chat.name.toLowerCase().includes(needle) ||
          chat.participants.some((p) => (p.name ?? "").toLowerCase().includes(needle) || (compact !== "" && p.handle.toLowerCase().includes(compact))),
      );
    }
    return all.slice(0, opts.limit);
  }

  /** Messages of one chat, oldest to newest: the newest `limit` (before a time, if given), or the first `limit` after a time. */
  read(chatId: string, opts: { before?: number; after?: number; limit: number }): Message[] {
    const where = ["c.guid = ?", this.notReaction];
    const params: Array<string | number> = [chatId];
    if (opts.before !== undefined) { where.push(`${DATE_MS} < ?`); params.push(opts.before); }
    if (opts.after !== undefined) { where.push(`${DATE_MS} > ?`); params.push(opts.after); }
    const ascending = opts.after !== undefined && opts.before === undefined;
    const dir = ascending ? "ASC" : "DESC";
    const rows = this.db
      .query(`${this.select()} WHERE ${where.join(" AND ")} ORDER BY m.date ${dir}, m.ROWID ${dir} LIMIT ?`)
      .all(...params, opts.limit) as MessageRow[];
    if (!ascending) rows.reverse();
    const first = rows[0];
    const reactions = first ? this.reactionsIn(first.chatRowid) : new Map();
    return rows.map((row) => this.toMessage(row, reactions));
  }

  /** Case-insensitive text search across all chats (or one), newest first; also reads attributedBody-only rows. */
  search(query: string, opts: { chat?: string; since?: number; limit: number }): SearchHit[] {
    const needle = query.toLowerCase();
    if (!needle) return [];
    const where = [this.notReaction];
    const params: Array<string | number> = [];
    if (opts.chat !== undefined) { where.push("c.guid = ?"); params.push(opts.chat); }
    if (opts.since !== undefined) { where.push(`${DATE_MS} >= ?`); params.push(opts.since); }
    const chats = this.allChats();
    const reactionCache = new Map<number, Reactions>();
    const hits: SearchHit[] = [];
    const rows = this.db.query(`${this.select()} WHERE ${where.join(" AND ")} ORDER BY m.date DESC, m.ROWID DESC`).iterate(...params) as Iterable<MessageRow>;
    for (const row of rows) {
      if (!this.textOf(row).toLowerCase().includes(needle)) continue;
      const chat = chats.get(row.chatGuid);
      if (!chat) continue;
      let reactions = reactionCache.get(row.chatRowid);
      if (!reactions) reactionCache.set(row.chatRowid, (reactions = this.reactionsIn(row.chatRowid)));
      hits.push({ chat, message: this.toMessage(row, reactions) });
      if (hits.length >= opts.limit) break;
    }
    return hits;
  }

  /** Per-chat counts of messages received and sent since a time, most recently active chat first. */
  activity(since: number, limit: number): ActivityRow[] {
    const chats = this.allChats();
    const byChat = new Map<string, ActivityRow>();
    const rows = this.db
      .query(`${this.select()} WHERE ${this.notReaction} AND ${DATE_MS} >= ? ORDER BY m.date DESC, m.ROWID DESC`)
      .all(since) as MessageRow[];
    for (const row of rows) {
      const chat = chats.get(row.chatGuid);
      if (!chat) continue;
      let entry = byChat.get(row.chatGuid);
      if (!entry) {
        entry = { chat, received: 0, sent: 0, last: this.toMessage(row, new Map()) };
        byChat.set(row.chatGuid, entry);
      }
      if (row.fromMe) entry.sent += 1;
      else entry.received += 1;
    }
    return [...byChat.values()].slice(0, limit);
  }

  /** Where an attachment lives on disk (its stored `~` expanded) and what it is called. */
  attachment(id: number): { path: string; name: string; mime?: string; bytes?: number } | undefined {
    const row = this.db
      .query("SELECT filename, mime_type AS mime, transfer_name AS name, total_bytes AS bytes FROM attachment WHERE ROWID = ?")
      .get(id) as { filename: string | null; mime: string | null; name: string | null; bytes: number | null } | null;
    if (!row?.filename) return undefined;
    const path = row.filename.startsWith("~") ? this.home + row.filename.slice(1) : row.filename;
    return { path, name: row.name ?? basename(path), ...(row.mime ? { mime: row.mime } : {}), ...(row.bytes != null ? { bytes: row.bytes } : {}) };
  }

  /** Looks for a message you sent to a chat (by id) or a person (by handle) since a time with exactly this text. */
  sentSince(chatOrHandle: string, sinceMs: number, text: string): { delivered: boolean; error: number } | undefined {
    const ids = [...this.allChats().values()]
      .filter((chat) => chat.id === chatOrHandle || (!chat.isGroup && chat.participants.some((p) => sameHandle(p.handle, chatOrHandle))))
      .map((chat) => chat.id);
    if (ids.length === 0) return undefined;
    const delivered = this.columns.has("is_delivered") ? "m.is_delivered" : "1";
    const error = this.columns.has("error") ? "m.error" : "0";
    const rows = this.db
      .query(
        `${this.select(`${delivered} AS delivered, ${error} AS error`)} WHERE m.is_from_me = 1 AND ${this.notReaction}
         AND c.guid IN (${ids.map(() => "?").join(", ")}) AND ${DATE_MS} >= ? ORDER BY m.date DESC`,
      )
      .all(...ids, sinceMs) as Array<MessageRow & { delivered: number | null; error: number | null }>;
    const wanted = text.trim();
    for (const row of rows) {
      if (appleToUnixMs(row.date) < sinceMs || this.textOf(row) !== wanted) continue;
      return { delivered: row.delivered === 1, error: row.error ?? 0 };
    }
    return undefined;
  }

  private select(extra?: string): string {
    const body = this.columns.has("attributedBody") ? "m.attributedBody" : "NULL";
    const reply = [this.columns.has("reply_to_guid") && "NULLIF(m.reply_to_guid, '')", this.columns.has("thread_originator_guid") && "NULLIF(m.thread_originator_guid, '')"].filter(Boolean);
    return `SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, ${body} AS body, h.id AS handle, m.is_from_me AS fromMe, m.date AS date,
      ${reply.length > 1 ? `COALESCE(${reply.join(", ")})` : (reply[0] ?? "NULL")} AS reply, c.guid AS chatGuid, c.ROWID AS chatRowid${extra ? `, ${extra}` : ""}
      FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id LEFT JOIN handle h ON h.ROWID = m.handle_id`;
  }

  private textOf(row: Pick<MessageRow, "text" | "body">): string {
    const raw = row.text ? row.text : (decodeAttributedBody(row.body) ?? "");
    return raw.replace(/\uFFFC/g, "").trim();
  }

  private person(handle: string): Participant {
    const name = this.names(handle);
    return name ? { handle, name } : { handle };
  }

  private toMessage(row: MessageRow, reactions: Reactions): Message {
    const attachments = (
      this.db
        .query(
          `SELECT a.ROWID AS id, a.filename AS filename, a.transfer_name AS name, a.mime_type AS mime, a.total_bytes AS bytes
           FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id = ? ORDER BY a.ROWID`,
        )
        .all(row.rowid) as Array<{ id: number; filename: string | null; name: string | null; mime: string | null; bytes: number | null }>
    ).map((a): AttachmentRef => ({ id: a.id, name: a.name ?? basename(a.filename ?? `attachment-${a.id}`), ...(a.mime ? { mime: a.mime } : {}), ...(a.bytes != null ? { bytes: a.bytes } : {}) }));
    const fromMe = row.fromMe === 1;
    return {
      guid: row.guid,
      at: appleToUnixMs(row.date),
      fromMe,
      ...(!fromMe && row.handle ? { sender: this.person(normalizeHandle(row.handle)) } : {}),
      text: this.textOf(row),
      attachments,
      ...(row.reply ? { replyTo: row.reply.replace(TARGET_PREFIX, "") } : {}),
      reactions: reactions.get(row.guid) ?? [],
    };
  }

  /** Tapbacks of one chat as "emoji by who" lists keyed by target message guid; a removal cancels the matching one. */
  private reactionsIn(chatRowid: number): Reactions {
    if (!this.columns.has("associated_message_type")) return new Map();
    const rows = this.db
      .query(
        `SELECT m.associated_message_type AS type, m.associated_message_guid AS target, m.is_from_me AS fromMe, h.id AS handle
         FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE j.chat_id = ? AND m.associated_message_type BETWEEN 2000 AND 3999 AND m.associated_message_guid IS NOT NULL ORDER BY m.date, m.ROWID`,
      )
      .all(chatRowid) as Array<{ type: number; target: string; fromMe: number; handle: string | null }>;
    const live = new Map<string, Map<string, { kind: number; label: string }>>();
    for (const row of rows) {
      const target = row.target.replace(TARGET_PREFIX, "");
      const handle = row.handle ? normalizeHandle(row.handle) : undefined;
      const who = row.fromMe ? "you" : handle ? (this.names(handle) ?? handle) : "someone";
      const senders = live.get(target) ?? new Map<string, { kind: number; label: string }>();
      live.set(target, senders);
      const kind = row.type % 1000;
      if (row.type >= 3000) {
        if (senders.get(who)?.kind === kind) senders.delete(who);
      } else if (TAPBACKS[kind]) {
        senders.set(who, { kind, label: `${TAPBACKS[kind]} by ${who}` });
      }
    }
    return new Map([...live].map(([target, senders]) => [target, [...senders.values()].map((s) => s.label)]));
  }

  private allChats(): Map<string, ChatSummary> {
    const rows = this.db
      .query("SELECT ROWID AS rowid, guid, display_name AS display, chat_identifier AS ident, service_name AS service, style FROM chat")
      .all() as ChatRow[];
    const members = new Map<number, string[]>();
    const joined = this.db.query("SELECT chj.chat_id AS chat, h.id AS handle FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id").all() as Array<{ chat: number; handle: string }>;
    for (const r of joined) {
      const list = members.get(r.chat) ?? [];
      list.push(normalizeHandle(r.handle));
      members.set(r.chat, list);
    }
    const last = new Map<number, number>();
    const lastRows = this.db.query(`SELECT j.chat_id AS chat, MAX(m.date) AS date FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID WHERE ${this.notReaction} GROUP BY j.chat_id`).all() as Array<{ chat: number; date: number }>;
    for (const r of lastRows) last.set(r.chat, r.date);
    const unread = new Map<number, number>();
    if (this.columns.has("is_read")) {
      const unreadRows = this.db.query(`SELECT j.chat_id AS chat, COUNT(*) AS n FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID WHERE m.is_from_me = 0 AND m.is_read = 0 AND ${this.notReaction} GROUP BY j.chat_id`).all() as Array<{ chat: number; n: number }>;
      for (const r of unreadRows) unread.set(r.chat, r.n);
    }
    const out = new Map<string, ChatSummary>();
    for (const row of rows) {
      const participants = (members.get(row.rowid) ?? []).map((handle) => this.person(handle));
      const isGroup = row.style !== null ? row.style === 43 : row.guid.includes(";+;");
      const fallback = participants.map((p) => p.name ?? p.handle).join(", ") || row.ident || row.guid;
      const lastDate = last.get(row.rowid);
      out.set(row.guid, {
        id: row.guid,
        name: row.display?.trim() || fallback,
        participants,
        service: row.service ?? "iMessage",
        isGroup,
        ...(lastDate !== undefined ? { lastAt: appleToUnixMs(lastDate) } : {}),
        unread: unread.get(row.rowid) ?? 0,
      });
    }
    return out;
  }
}
