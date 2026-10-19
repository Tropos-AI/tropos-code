// src/memory/search-index.ts
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { journalDir } from "../paths";
import { projectDir, type MessageParam } from "../session/store";
import { DAY_FILE, entryProjectDir, readJournalDay } from "./daily";

/** A session transcript's file name: "<uuid>.jsonl". */
export const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** Transcripts can grow large; a file past this is skipped rather than loaded into memory. */
export const MAX_SESSION_BYTES = 50 * 1024 * 1024;

/** Text blocks that are harness scaffolding (memory files, mode notes), not something the user typed. */
export const SCAFFOLD = /^\s*<(context|mode|reminder|hook-context)>/;

/** Raw lines that count as one message: indexes are assigned before parsing so every reader agrees. */
export const MESSAGE_LINE_PREFIX = '{"type":"message"';

/** The typed text of a message: string content or text blocks; thinking, tool calls and tool results are left out. */
export function messageTexts(message: MessageParam): string[] {
  if (typeof message.content === "string") return [message.content];
  if (!Array.isArray(message.content)) return [];
  const out: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") out.push(block.text);
  }
  return out;
}

export interface SessionMessage {
  /** Ordinal of the message line in the transcript (see MESSAGE_LINE_PREFIX). */
  index: number;
  role: "user" | "assistant";
  /** Typed text, harness scaffolding removed. */
  texts: string[];
  /** Names of tools an assistant message called. */
  tools: string[];
}

export interface ParsedSession {
  title?: string;
  cwd?: string;
  /** Who the session answered to (src/session/store.ts SessionMeta.role); absent in older transcripts. */
  role?: string;
  messages: SessionMessage[];
}

/** Parses a JSONL transcript leniently: lines cut short by a crash are skipped but still use up an index. */
export function parseSession(text: string): ParsedSession {
  const out: ParsedSession = { messages: [] };
  let index = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const at = raw.startsWith(MESSAGE_LINE_PREFIX) ? index++ : -1;
    let line: { type?: unknown; title?: unknown; cwd?: unknown; role?: unknown; message?: MessageParam };
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof line !== "object" || line === null) continue;
    if (line.type === "meta") {
      if (typeof line.title === "string") out.title = line.title;
      if (typeof line.cwd === "string") out.cwd = line.cwd;
      // Once a guest's, always: their earlier words stay in the transcript whatever the chat's role later became.
      if (typeof line.role === "string" && out.role !== "guest") out.role = line.role;
      continue;
    }
    const message = line.message;
    if (at < 0 || line.type !== "message" || typeof message !== "object" || message === null) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const texts = messageTexts(message).filter((t) => !(message.role === "user" && SCAFFOLD.test(t)));
    const tools: string[] = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === "tool_use" && typeof block.name === "string") tools.push(block.name);
    }
    out.messages.push({ index: at, role: message.role, texts, tools });
  }
  return out;
}

/** A transcript of a guest's chat (or of a subagent it ran): search never shows it. */
export const isGuestSession = (parsed: Pick<ParsedSession, "role">): boolean => parsed.role === "guest";

/** Splits a day file into entries: a line starting with "- " opens one, indented lines continue it. */
export function noteEntries(text: string): string[] {
  const entries: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("- ") || entries.length === 0) entries.push(line);
    else entries[entries.length - 1] += `\n${line}`;
  }
  return entries;
}

/**
 * An FTS5 MATCH expression from free text: each word becomes a quoted prefix phrase, so user input can
 * never be read as FTS syntax (AND, NEAR, column filters, unbalanced quotes). null when no word is left.
 */
export function ftsQuery(query: string): string | null {
  const tokens = query.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

export type SearchSource = "sessions" | "notes" | "all";

export interface SearchSnippet {
  role?: string;
  /** Message index for sessions, entry index for notes. */
  index?: number;
  text: string;
}

export interface SearchResult {
  kind: "session" | "note";
  /** Session id, or the note's date. */
  id: string;
  /** The project directory under <home>/projects. */
  project: string;
  /** The working directory a session ran in, when its transcript says. */
  cwd?: string;
  title: string;
  date: string;
  snippets: SearchSnippet[];
  /** Higher is better (negated BM25 of the best hit). */
  score: number;
}

export interface SearchOptions {
  source: SearchSource;
  projectDirs: string[];
  excludeSessionId?: string;
  limit: number;
}

export interface RefreshOptions {
  home: string;
  cwd?: string;
  allProjects?: boolean;
  /** A session still being written (the current one): left as it is rather than re-read on every search. */
  excludeSessionId?: string;
}

const SCHEMA_VERSION = 2;
/** Chunk rowids are docId * STRIDE + index, so a document's chunks are one rowid range (cheap to delete). */
const STRIDE = 1 << 20;
const SNIPPETS_PER_RESULT = 3;
const SNIPPET_TOKENS = 24;

interface DiskFile {
  path: string;
  kind: "session" | "note";
  docId: string;
  mtime: number;
  size: number;
}

interface DocRow {
  id: number;
  path: string;
  mtime: number;
  size: number;
}

interface HitRow {
  doc: number;
  kind: "session" | "note";
  project: string;
  doc_id: string;
  title: string;
  cwd: string | null;
  date: string;
  role: string;
  idx: number;
  snip: string;
  rank: number;
}

const SCHEMA = `
DROP TABLE IF EXISTS docs;
DROP TABLE IF EXISTS chunks;
CREATE TABLE docs (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  project TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT,
  date TEXT NOT NULL,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL
);
CREATE INDEX docs_project ON docs(project);
CREATE VIRTUAL TABLE chunks USING fts5(body, role UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
PRAGMA user_version = ${SCHEMA_VERSION};
`;

/** A project's session transcripts, subagent ones (subagents/<parent>/<id>.jsonl) included. */
export async function sessionPaths(dir: string): Promise<Array<{ path: string; id: string }>> {
  const out: Array<{ path: string; id: string }> = [];
  const idOf = (name: string) => name.slice(0, -".jsonl".length);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (SESSION_FILE.test(name)) out.push({ path: join(dir, name), id: idOf(name) });
  }
  const subagents = join(dir, "subagents");
  for (const parent of await readdir(subagents).catch(() => [] as string[])) {
    for (const name of await readdir(join(subagents, parent)).catch(() => [] as string[])) {
      if (SESSION_FILE.test(name)) out.push({ path: join(subagents, parent, name), id: idOf(name) });
    }
  }
  return out;
}

async function diskFiles(dir: string): Promise<DiskFile[]> {
  const out: DiskFile[] = [];
  const add = async (path: string, kind: DiskFile["kind"], docId: string, maxBytes: number) => {
    try {
      const info = await stat(path);
      if (info.isFile() && info.size <= maxBytes) out.push({ path, kind, docId, mtime: info.mtimeMs, size: info.size });
    } catch {
      // vanished between readdir and stat
    }
  };
  for (const s of await sessionPaths(dir)) await add(s.path, "session", s.id, MAX_SESSION_BYTES);
  const notes = join(dir, "notes");
  for (const name of await readdir(notes).catch(() => [] as string[])) {
    const date = DAY_FILE.exec(name)?.[1];
    if (date) await add(join(notes, name), "note", date, MAX_SESSION_BYTES);
  }
  return out;
}

/**
 * Full-text index (SQLite FTS5, BM25 ranking) over session transcripts and daily notes at
 * <home>/index.db (the journal at workspace/memory is indexed per project too). It is a cache: every file it holds can be rebuilt from the transcripts, so a
 * schema change simply drops and rebuilds it.
 */
export class SearchIndex {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(private readonly db: Database) {}

  /** Opens (or creates) the index; null when SQLite or FTS5 is unavailable or the file is unusable. */
  static open(home: string): SearchIndex | null {
    let db: Database | undefined;
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const path = join(home, "index.db");
      // The index holds transcript text: create it owner-only before SQLite opens it.
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
      db = new Database(path);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
      if (user_version !== SCHEMA_VERSION) db.transaction(() => db!.exec(SCHEMA))();
      return new SearchIndex(db);
    } catch {
      try {
        db?.close();
      } catch {
        // already unusable
      }
      return null;
    }
  }

  /** Re-indexes transcripts and day files whose mtime or size changed, and forgets removed ones. Serialized. */
  refresh(opts: RefreshOptions): Promise<void> {
    const run = this.queue.then(() => this.refreshNow(opts));
    this.queue = run.catch(() => {});
    return run;
  }

  search(query: string, opts: SearchOptions): SearchResult[] {
    const match = ftsQuery(query);
    if (match === null || opts.projectDirs.length === 0 || opts.limit <= 0) return [];
    const kinds = opts.source === "all" ? ["session", "note"] : [opts.source === "sessions" ? "session" : "note"];
    const params: Array<string | number> = [match, ...opts.projectDirs, ...kinds];
    let exclude = "";
    if (opts.excludeSessionId) {
      // The current session's own subagent transcripts (subagents/<id>/) are excluded with it.
      exclude = "AND NOT (docs.kind = 'session' AND (docs.doc_id = ? OR instr(docs.path, ?) > 0))";
      params.push(opts.excludeSessionId, `${sep}subagents${sep}${opts.excludeSessionId}${sep}`);
    }
    params.push(Math.max(200, opts.limit * 40));
    const rows = this.db
      .query(
        `SELECT docs.id AS doc, docs.kind AS kind, docs.project AS project, docs.doc_id AS doc_id, docs.title AS title,
                docs.cwd AS cwd, docs.date AS date, chunks.role AS role, (chunks.rowid % ${STRIDE}) AS idx,
                snippet(chunks, 0, '**', '**', '…', ${SNIPPET_TOKENS}) AS snip, bm25(chunks) AS rank
         FROM chunks JOIN docs ON docs.id = (chunks.rowid / ${STRIDE})
         WHERE chunks MATCH ?
           AND docs.project IN (${opts.projectDirs.map(() => "?").join(", ")})
           AND docs.kind IN (${kinds.map(() => "?").join(", ")})
           ${exclude}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params) as HitRow[];

    const groups = new Map<number, SearchResult>();
    for (const row of rows) {
      let group = groups.get(row.doc);
      if (!group) {
        if (groups.size >= opts.limit) continue;
        group = {
          kind: row.kind,
          id: row.doc_id,
          project: row.project,
          ...(row.cwd ? { cwd: row.cwd } : {}),
          title: row.title,
          date: row.date,
          snippets: [],
          score: -row.rank,
        };
        groups.set(row.doc, group);
      }
      if (group.snippets.length >= SNIPPETS_PER_RESULT) continue;
      group.snippets.push({ ...(row.role ? { role: row.role } : {}), index: row.idx, text: row.snip.replace(/\s+/g, " ").trim() });
    }
    return [...groups.values()];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private async refreshNow(opts: RefreshOptions): Promise<void> {
    const root = join(opts.home, "projects");
    let dirs: string[];
    if (opts.allProjects) {
      dirs = (await readdir(root).catch(() => [] as string[])).map((name) => join(root, name));
      // Projects whose folder is gone entirely.
      const known = this.db.query("SELECT DISTINCT project FROM docs").all() as Array<{ project: string }>;
      for (const { project } of known) {
        if (project.startsWith(root) && !dirs.includes(project)) this.forgetProject(project, `${journalDir(opts.home)}${sep}`);
      }
    } else {
      dirs = opts.cwd ? [projectDir(opts.home, opts.cwd)] : [];
    }
    const journal = `${journalDir(opts.home)}${sep}`;
    for (const dir of dirs) await this.refreshProject(dir, journal, opts.excludeSessionId);
    await this.refreshJournal(opts.home, journal);
  }

  /**
   * workspace/memory/<date>.md holds every project's entries. Each day file becomes one `note` doc per project in it
   * (path "<file>#<project dir>"), all replaced together when the file's mtime or size changes.
   */
  private async refreshJournal(home: string, prefix: string): Promise<void> {
    const dir = journalDir(home);
    const days = new Map<string, { date: string; mtime: number; size: number }>();
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const date = DAY_FILE.exec(name)?.[1];
      if (!date) continue;
      try {
        const info = await stat(join(dir, name));
        if (info.isFile() && info.size <= MAX_SESSION_BYTES) days.set(join(dir, name), { date, mtime: info.mtimeMs, size: info.size });
      } catch {
        // vanished between readdir and stat
      }
    }
    const known = this.db.query("SELECT id, path, mtime, size FROM docs WHERE substr(path, 1, ?) = ?").all(prefix.length, prefix) as DocRow[];
    const byFile = new Map<string, DocRow[]>();
    for (const row of known) {
      const file = row.path.slice(0, row.path.indexOf("#", prefix.length));
      byFile.set(file, [...(byFile.get(file) ?? []), row]);
    }
    for (const [file, rows] of byFile) {
      const day = days.get(file);
      if (day && rows.every((r) => r.mtime === day.mtime && r.size === day.size)) continue;
      this.db.transaction(() => rows.forEach((r) => this.deleteDoc(r.id)))();
      byFile.delete(file);
    }
    for (const [file, day] of days) {
      if (byFile.has(file)) continue;
      const perProject = new Map<string, string[]>();
      for (const entry of await readJournalDay(file)) {
        const project = entryProjectDir(home, entry);
        if (!project) continue;
        perProject.set(project, [...(perProject.get(project) ?? []), entry.body]);
      }
      for (const [project, bodies] of perProject) {
        this.indexDoc({ project, path: `${file}#${project}`, kind: "note", docId: day.date, title: `Notes ${day.date}`, cwd: null, date: day.date, mtime: day.mtime, size: day.size }, bodies.map((body, index) => ({ index, role: "", body })));
      }
    }
  }

  /** Drops a project's sessions and legacy notes; its journal entries live in the shared day files and stay. */
  private forgetProject(project: string, journal: string): void {
    const rows = this.db.query("SELECT id, path, mtime, size FROM docs WHERE project = ? AND substr(path, 1, ?) <> ?").all(project, journal.length, journal) as DocRow[];
    this.db.transaction(() => rows.forEach((r) => this.deleteDoc(r.id)))();
  }

  private async refreshProject(dir: string, journal: string, excludeSessionId?: string): Promise<void> {
    const files = await diskFiles(dir);
    const onDisk = new Set(files.map((f) => f.path));
    const known = new Map<string, DocRow>();
    for (const row of this.db.query("SELECT id, path, mtime, size FROM docs WHERE project = ? AND substr(path, 1, ?) <> ?").all(dir, journal.length, journal) as DocRow[]) {
      known.set(row.path, row);
    }
    const gone = [...known.values()].filter((r) => !onDisk.has(r.path));
    if (gone.length > 0) this.db.transaction(() => gone.forEach((r) => this.deleteDoc(r.id)))();

    for (const file of files) {
      const row = known.get(file.path);
      if (row && row.mtime === file.mtime && row.size === file.size) continue;
      if (file.kind === "session" && excludeSessionId && (file.docId === excludeSessionId || file.path.includes(`${sep}subagents${sep}${excludeSessionId}${sep}`))) continue;
      let text: string;
      try {
        text = await readFile(file.path, "utf8");
      } catch {
        continue; // unreadable or removed meanwhile; the next refresh sees it gone
      }
      this.indexFile(dir, file, text);
    }
  }

  private indexFile(project: string, file: DiskFile, text: string): void {
    let title: string;
    let cwd: string | null = null;
    let date: string;
    const chunks: Array<{ index: number; role: string; body: string }> = [];
    if (file.kind === "session") {
      const parsed = parseSession(text);
      title = parsed.title ?? "(untitled)";
      cwd = parsed.cwd ?? null;
      date = new Date(file.mtime).toISOString().slice(0, 10);
      // A guest's words never reach the owner's sessions through search: indexed (so it isn't re-read), with no text.
      for (const m of isGuestSession(parsed) ? [] : parsed.messages) {
        const body = m.texts.join("\n\n").trim();
        if (body && m.index < STRIDE) chunks.push({ index: m.index, role: m.role, body });
      }
    } else {
      title = `Notes ${file.docId}`;
      date = file.docId;
      noteEntries(text).forEach((body, index) => {
        if (index < STRIDE) chunks.push({ index, role: "", body });
      });
    }
    this.indexDoc({ project, path: file.path, kind: file.kind, docId: file.docId, title, cwd, date, mtime: file.mtime, size: file.size }, chunks);
  }

  private indexDoc(
    doc: { project: string; path: string; kind: DiskFile["kind"]; docId: string; title: string; cwd: string | null; date: string; mtime: number; size: number },
    chunks: Array<{ index: number; role: string; body: string }>,
  ): void {
    this.db.transaction(() => {
      const { id } = this.db
        .query(
          `INSERT INTO docs (path, kind, project, doc_id, title, cwd, date, mtime, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, project = excluded.project, doc_id = excluded.doc_id,
             title = excluded.title, cwd = excluded.cwd, date = excluded.date, mtime = excluded.mtime, size = excluded.size
           RETURNING id`,
        )
        .get(doc.path, doc.kind, doc.project, doc.docId, doc.title, doc.cwd, doc.date, doc.mtime, doc.size) as { id: number };
      this.db.query("DELETE FROM chunks WHERE rowid >= ? AND rowid < ?").run(id * STRIDE, (id + 1) * STRIDE);
      const insert = this.db.query("INSERT INTO chunks (rowid, body, role) VALUES (?, ?, ?)");
      for (const c of chunks) if (c.index < STRIDE) insert.run(id * STRIDE + c.index, c.body, c.role);
    })();
  }

  private deleteDoc(id: number): void {
    this.db.query("DELETE FROM chunks WHERE rowid >= ? AND rowid < ?").run(id * STRIDE, (id + 1) * STRIDE);
    this.db.query("DELETE FROM docs WHERE id = ?").run(id);
  }
}
