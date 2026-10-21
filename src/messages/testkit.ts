// src/messages/testkit.ts — builds fixture chat.db and address-book files with the real table and column names (tests only)
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

export interface FixtureChat {
  guid: string;
  identifier?: string;
  displayName?: string;
  service?: string;
  handles: string[];
}
export interface FixtureMessage {
  guid: string;
  chat: string;
  /** The other party's handle; omit for messages you sent. */
  handle?: string;
  fromMe?: boolean;
  text?: string;
  /** Text stored only in the attributedBody typedstream, as macOS often does. */
  bodyOnly?: string;
  /** Unix milliseconds. */
  at: number;
  read?: boolean;
  delivered?: boolean;
  error?: number;
  assocType?: number;
  assocGuid?: string;
  replyTo?: string;
  attachments?: Array<{ filename: string; mime?: string; name?: string; bytes?: number }>;
}
export interface ChatDbFixture {
  chats: FixtureChat[];
  messages: FixtureMessage[];
  /** "older" drops the columns newer macOS versions add. */
  variant?: "sonoma" | "older";
}

const enc = new TextEncoder();

/** A blob shaped like a real attributedBody around the string (short strings only). */
export function typedstream(text: string): Uint8Array {
  const body = enc.encode(text);
  const n = body.length;
  const len = n < 0x80 ? [n] : [0x81, n & 0xff, n >> 8];
  const head = [...enc.encode("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString"), 0x01, 0x94, 0x84, 0x01, 0x2b, ...len];
  const tail = enc.encode("\x86\x84\x02iI\x01");
  const out = new Uint8Array(head.length + n + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + n);
  return out;
}

/** Unix milliseconds as chat.db stores them: nanoseconds since 2001-01-01. */
export function toAppleNs(ms: number): number {
  return Math.round((ms / 1000 - 978307200) * 1e9);
}

/** Creates a chat.db at `path` (replacing any file there) and fills it from the fixture. */
export function buildChatDb(path: string, fixture: ChatDbFixture): void {
  rmSync(path, { force: true });
  const older = fixture.variant === "older";
  const db = new Database(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT, style INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, ${older ? "" : "attributedBody BLOB, thread_originator_guid TEXT,"}
      handle_id INTEGER, is_from_me INTEGER, is_read INTEGER, is_delivered INTEGER, error INTEGER, date INTEGER,
      associated_message_type INTEGER, associated_message_guid TEXT, reply_to_guid TEXT, cache_has_attachments INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  const handleIds = new Map<string, number>();
  const handleId = (id: string): number => {
    let rowid = handleIds.get(id);
    if (rowid === undefined) {
      rowid = (db.query("INSERT INTO handle (id, service) VALUES (?, 'iMessage')").run(id).lastInsertRowid as number) ?? 0;
      handleIds.set(id, rowid);
    }
    return rowid;
  };
  const chatIds = new Map<string, number>();
  for (const chat of fixture.chats) {
    const group = chat.guid.includes(";+;");
    const rowid = db
      .query("INSERT INTO chat (guid, chat_identifier, display_name, service_name, style) VALUES (?, ?, ?, ?, ?)")
      .run(chat.guid, chat.identifier ?? chat.handles[0] ?? chat.guid, chat.displayName ?? "", chat.service ?? "iMessage", group ? 43 : 45)
      .lastInsertRowid as number;
    chatIds.set(chat.guid, rowid);
    for (const handle of chat.handles) db.query("INSERT INTO chat_handle_join VALUES (?, ?)").run(rowid, handleId(handle));
  }
  for (const m of fixture.messages) {
    const date = toAppleNs(m.at);
    const columns = ["guid", "text", "handle_id", "is_from_me", "is_read", "is_delivered", "error", "date", "associated_message_type", "associated_message_guid", "reply_to_guid", "cache_has_attachments"];
    const values: Array<string | number | Uint8Array | null> = [
      m.guid, m.text ?? null, m.handle ? handleId(m.handle) : 0, m.fromMe ? 1 : 0, m.read === false ? 0 : 1,
      m.delivered === false ? 0 : 1, m.error ?? 0, date, m.assocType ?? 0, m.assocGuid ?? null, m.replyTo ?? null, m.attachments?.length ? 1 : 0,
    ];
    if (!older) {
      columns.push("attributedBody");
      values.push(m.bodyOnly === undefined ? null : typedstream(m.bodyOnly));
    }
    const rowid = db
      .query(`INSERT INTO message (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...values).lastInsertRowid as number;
    db.query("INSERT INTO chat_message_join VALUES (?, ?, ?)").run(chatIds.get(m.chat) ?? 0, rowid, date);
    for (const a of m.attachments ?? []) {
      const attachmentId = db
        .query("INSERT INTO attachment (guid, filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?)")
        .run(`att-${rowid}`, a.filename, a.mime ?? null, a.name ?? null, a.bytes ?? null).lastInsertRowid as number;
      db.query("INSERT INTO message_attachment_join VALUES (?, ?)").run(rowid, attachmentId);
    }
  }
  db.close();
}

export interface FixturePerson {
  first?: string;
  last?: string;
  org?: string;
  phones?: string[];
  emails?: string[];
}

/** Creates an AddressBook-v22.abcddb at `path` (replacing any file there). */
export function buildAddressBook(path: string, people: FixturePerson[]): void {
  rmSync(path, { force: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
  `);
  for (const p of people) {
    const owner = db
      .query("INSERT INTO ZABCDRECORD (ZFIRSTNAME, ZLASTNAME, ZORGANIZATION) VALUES (?, ?, ?)")
      .run(p.first ?? null, p.last ?? null, p.org ?? null).lastInsertRowid as number;
    for (const n of p.phones ?? []) db.query("INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)").run(owner, n);
    for (const e of p.emails ?? []) db.query("INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)").run(owner, e);
  }
  db.close();
}
