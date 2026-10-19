// src/memory/session-search.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";
import { neutraliseHarnessTags } from "../context/tags";
import { errorText } from "../error-text";
import { journalDir } from "../paths";
import { projectDir, type MessageParam } from "../session/store";
import { defineTool, type AnyTool, type ToolContext, type ToolOutput } from "../tools/types";
import { DAY_FILE, readJournalDay, type JournalEntry } from "./daily";
import {
  MAX_SESSION_BYTES,
  MESSAGE_LINE_PREFIX,
  SCAFFOLD,
  sessionPaths,
  SearchIndex,
  messageTexts,
  noteEntries,
  isGuestSession,
  parseSession,
  type SearchResult,
  type SearchSource,
} from "./search-index";

export { MAX_SESSION_BYTES } from "./search-index";

const schema = z.object({
  query: z
    .string()
    .optional()
    .describe("Words to find; results contain every word (prefix match, case-insensitive). Needed unless session_id is given."),
  source: z
    .enum(["sessions", "notes", "all"])
    .optional()
    .describe('Where to search: past conversations, daily notes, or both (default "all").'),
  session_id: z
    .string()
    .optional()
    .describe("Read mode: a session id from an earlier result (or a note date YYYY-MM-DD) to show its messages."),
  around: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Read mode: the message index (#n in results) to center on; shows 5 messages either side. Default: the start."),
  all_projects: z.boolean().optional().describe("Search sessions from every project, not just this one."),
  limit: z.number().int().min(1).max(20).optional().describe("Most results to return (default 10, at most 20)."),
});

type Input = z.infer<typeof schema>;

const DEFAULT_LIMIT = 10;
const SNIPPETS_PER_SESSION = 3;
const SNIPPET_RADIUS = 200;
/** Read mode shows this many messages either side of `around`. */
const READ_RADIUS = 5;
/** One message's longest text in read mode. */
const READ_MESSAGE_CHARS = 2_000;
/** Keeps one search from flooding the context window. */
export const MAX_OUTPUT_CHARS = 20_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Candidate {
  kind: "session" | "note";
  id: string;
  path: string;
  project: string;
  mtime: Date;
  /** A journal day: it holds every project's entries, so `project` is not meaningful and the scan groups them. */
  journal?: boolean;
}

/** Session and day files of the given project directories, newest first. */
async function candidateFiles(home: string, dirs: string[], source: SearchSource): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const add = async (c: Omit<Candidate, "mtime">) => {
    try {
      const info = await stat(c.path);
      if (info.isFile() && info.size <= MAX_SESSION_BYTES) out.push({ ...c, mtime: info.mtime });
    } catch {
      // vanished between readdir and stat
    }
  };
  for (const dir of dirs) {
    if (source !== "notes") {
      for (const s of await sessionPaths(dir)) await add({ kind: "session", id: s.id, path: s.path, project: dir });
    }
    if (source !== "sessions") {
      const notes = join(dir, "notes");
      for (const name of await readdir(notes).catch(() => [] as string[])) {
        const date = DAY_FILE.exec(name)?.[1];
        if (date) await add({ kind: "note", id: date, path: join(notes, name), project: dir });
      }
    }
  }
  if (source !== "sessions") {
    const journal = journalDir(home);
    for (const name of await readdir(journal).catch(() => [] as string[])) {
      const date = DAY_FILE.exec(name)?.[1];
      if (date) await add({ kind: "note", id: date, path: join(journal, name), project: "", journal: true });
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function snippet(text: string, words: string[]): string {
  const lower = text.toLowerCase();
  let at = lower.length;
  for (const w of words) at = Math.min(at, lower.indexOf(w));
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/**
 * Words JSON.stringify writes unchanged, so a raw-line pre-check can skip parsing lines that can't
 * match. Words with quotes, backslashes or control characters are escaped on disk and can't be pre-checked.
 */
function rawSafe(word: string): boolean {
  return !/["\\\u0000-\u001f]/.test(word);
}

/** Substring scan of one transcript (the fallback when the index is unavailable). */
function scanSession(text: string, words: string[]): Pick<SearchResult, "title" | "cwd" | "snippets"> | null {
  const result: Pick<SearchResult, "title" | "cwd" | "snippets"> = { title: "(untitled)", snippets: [] };
  const safe = words.filter(rawSafe);
  let index = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const isMeta = raw.startsWith('{"type":"meta"');
    const at = raw.startsWith(MESSAGE_LINE_PREFIX) ? index++ : -1;
    if (!isMeta) {
      if (at < 0 || result.snippets.length >= SNIPPETS_PER_SESSION) continue;
      const lower = raw.toLowerCase();
      if (!safe.every((w) => lower.includes(w))) continue;
    }
    let line: { type?: unknown; title?: unknown; cwd?: unknown; role?: unknown; message?: MessageParam };
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // a line cut short by a crash
    }
    if (typeof line !== "object" || line === null) continue;
    if (line.type === "meta") {
      if (typeof line.role === "string" && isGuestSession({ role: line.role })) return null;
      if (typeof line.title === "string") result.title = line.title;
      if (typeof line.cwd === "string") result.cwd = line.cwd;
      continue;
    }
    const message = line.message;
    if (line.type !== "message" || typeof message !== "object" || message === null) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    for (const t of messageTexts(message)) {
      if (result.snippets.length >= SNIPPETS_PER_SESSION) break;
      if (message.role === "user" && SCAFFOLD.test(t)) continue;
      const lower = t.toLowerCase();
      if (words.every((w) => lower.includes(w))) result.snippets.push({ role: message.role, index: at, text: snippet(t, words) });
    }
  }
  return result.snippets.length > 0 ? result : null;
}

function scanNotes(text: string, words: string[]): SearchResult["snippets"] {
  const out: SearchResult["snippets"] = [];
  noteEntries(text).forEach((entry, index) => {
    const lower = entry.toLowerCase();
    if (out.length < SNIPPETS_PER_SESSION && words.every((w) => lower.includes(w))) out.push({ index, text: snippet(entry, words) });
  });
  return out;
}

/** A journal day's entries grouped by the searched project (a key of `dirs`) they belong to. */
function journalByProject(entries: JournalEntry[], dirs: string[], home: string): Map<string, JournalEntry[]> {
  const out = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const project = projectDir(home, e.path);
    if (dirs.includes(project)) out.set(project, [...(out.get(project) ?? []), e]);
  }
  return out;
}

/** The fallback: plain substring matching over the files, newest first. */
async function scanSearch(home: string, dirs: string[], words: string[], source: SearchSource, limit: number, current: string | undefined, signal: AbortSignal): Promise<SearchResult[]> {
  const candidates = (await candidateFiles(home, dirs, source)).filter((c) => !(c.kind === "session" && (c.id === current || (current && c.path.includes(`${sep}subagents${sep}${current}${sep}`)))));
  const out: SearchResult[] = [];
  for (const c of candidates) {
    if (signal.aborted || out.length >= limit) break;
    if (c.journal) {
      // One result per searched project that has matching entries that day.
      for (const [project, entries] of journalByProject(await readJournalDay(c.path), dirs, home)) {
        const snippets: SearchResult["snippets"] = [];
        entries.forEach((e, index) => {
          const lower = e.body.toLowerCase();
          if (snippets.length < SNIPPETS_PER_SESSION && words.every((w) => lower.includes(w))) snippets.push({ index, text: snippet(e.body, words) });
        });
        if (snippets.length > 0 && out.length < limit) out.push({ kind: "note", id: c.id, project, score: 0, title: `Notes ${c.id}`, date: c.id, snippets });
      }
      continue;
    }
    let text: string;
    try {
      text = await readFile(c.path, "utf8");
    } catch {
      continue; // unreadable or removed meanwhile
    }
    const base = { kind: c.kind, id: c.id, project: c.project, score: 0 } as const;
    if (c.kind === "session") {
      const found = scanSession(text, words);
      if (found) out.push({ ...base, ...found, date: c.mtime.toISOString().slice(0, 10) });
    } else {
      const snippets = scanNotes(text, words);
      if (snippets.length > 0) out.push({ ...base, title: `Notes ${c.id}`, date: c.id, snippets });
    }
  }
  return out;
}

function formatResult(r: SearchResult, showProject: boolean): string {
  const where = showProject && r.cwd ? `, ${r.cwd}` : "";
  const head = r.kind === "session" ? `## ${r.title} (session ${r.id}, ${r.date}${where})` : `## ${r.title} (notes ${r.id}${where})`;
  const lines = r.snippets.map((s) => {
    const text = neutraliseHarnessTags(s.text);
    return r.kind === "session" ? `- [#${s.index} ${s.role}] ${text}` : `- ${text.replace(/^-\s+/, "")}`;
  });
  return [head, ...lines].join("\n");
}

async function projectDirs(home: string, cwd: string, all: boolean | undefined): Promise<string[]> {
  if (!all) return [projectDir(home, cwd)];
  const root = join(home, "projects");
  return (await readdir(root).catch(() => [] as string[])).map((name) => join(root, name));
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [cut at ${max.toLocaleString("en-US")} chars]` : text;
}

/** Read mode for a session: the messages around one index, text only. */
async function readSession(dirs: string[], id: string, around: number | undefined, input: Input): Promise<ToolOutput> {
  let path: string | undefined;
  for (const dir of dirs) {
    const candidate = (await sessionPaths(dir)).find((s) => s.id.toLowerCase() === id.toLowerCase())?.path;
    const info = candidate ? await stat(candidate).catch(() => null) : null;
    if (candidate && info?.isFile()) {
      if (info.size > MAX_SESSION_BYTES) return { content: `Session ${id} is too large to read.`, isError: true };
      path = candidate;
      break;
    }
  }
  if (!path) {
    const hint = input.all_projects ? "" : " Pass all_projects to look in other projects.";
    return { content: `No session ${id} in ${input.all_projects ? "any project" : "this project"}.${hint}`, isError: true };
  }
  const parsed = parseSession(await readFile(path, "utf8"));
  if (isGuestSession(parsed)) return { content: `Session ${id} was a guest's chat; it can't be read here.`, isError: true };
  const total = parsed.messages.length === 0 ? 0 : parsed.messages.at(-1)!.index + 1;
  const center = around ?? READ_RADIUS;
  const from = Math.max(0, center - READ_RADIUS);
  const to = center + READ_RADIUS;
  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  for (const m of parsed.messages) {
    if (m.index < from || m.index > to) continue;
    const text = m.texts.join("\n\n").trim();
    const tools = m.tools.length > 0 ? `(tool calls: ${m.tools.join(", ")})` : "";
    if (!text && !tools) continue; // tool results: not typed text
    const body = neutraliseHarnessTags([clip(text, READ_MESSAGE_CHARS), tools].filter(Boolean).join("\n"));
    const line = `[#${m.index} ${m.role}] ${body}`;
    if (used + line.length > MAX_OUTPUT_CHARS) {
      truncated = true;
      break;
    }
    used += line.length + 2;
    lines.push(line);
  }
  const title = parsed.title ?? "(untitled)";
  const head = `Session ${id} "${title}"${parsed.cwd ? ` (${parsed.cwd})` : ""}: messages ${from}–${Math.min(to, Math.max(0, total - 1))} of ${total}`;
  if (lines.length === 0) return { content: `${head}\n\n(no text in this range)`, summary: "no text" };
  const tail = truncated ? "\n\n(Cut at the size limit; read again with a later around.)" : "";
  return { content: `${head}\n\n${lines.join("\n\n")}${tail}`, summary: `${lines.length} message${lines.length === 1 ? "" : "s"}` };
}

/** Read mode for a date: that day's notes, from each project searched (legacy notes first, then the journal). */
async function readNotes(home: string, dirs: string[], date: string): Promise<ToolOutput> {
  const parts: string[] = [];
  const journal = journalByProject(await readJournalDay(join(journalDir(home), `${date}.md`)), dirs, home);
  for (const dir of dirs) {
    const legacy = await readFile(join(dir, "notes", `${date}.md`), "utf8").catch(() => null); // LEGACY_LAYOUT
    const entries = (journal.get(dir) ?? []).map((e) => `- ${e.time ? `${e.time} ` : ""}${e.body.replace(/\n/g, "\n  ")}`);
    const text = [legacy?.trim() ?? "", ...entries].filter(Boolean).join("\n");
    if (text) parts.push(`## Notes ${date}${dirs.length > 1 ? ` (${dir})` : ""}\n${neutraliseHarnessTags(clip(text, MAX_OUTPUT_CHARS))}`);
  }
  if (parts.length === 0) return { content: `No notes for ${date}.`, summary: "no notes" };
  return { content: clip(parts.join("\n\n"), MAX_OUTPUT_CHARS), summary: `notes ${date}` };
}

export interface SessionSearchOptions {
  home: string;
  cwd: string;
  currentSessionId?: () => string;
  /** A shared index; null forces the substring scan. When omitted, one is opened at <home>/index.db on first use. */
  index?: SearchIndex | null;
}

/**
 * SessionSearch: finds earlier conversations and daily notes by keyword so the model can recall what was
 * decided or done before, and reads a past session around a hit. Uses the FTS5 index (BM25 ranking)
 * when SQLite is available, otherwise a substring scan of the files, newest first.
 */
export function createSessionSearchTool(opts: SessionSearchOptions): AnyTool {
  let index: SearchIndex | null | undefined = opts.index;
  const getIndex = (): SearchIndex | null => {
    if (index === undefined) index = SearchIndex.open(opts.home);
    return index;
  };

  async function search(input: Input, query: string, ctx: ToolContext): Promise<ToolOutput> {
    const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
    if (words.length === 0) return { content: "query has no words to search for.", isError: true };
    const limit = input.limit ?? DEFAULT_LIMIT;
    const source = input.source ?? "all";
    const current = opts.currentSessionId?.();
    const dirs = await projectDirs(opts.home, opts.cwd, input.all_projects);

    let results: SearchResult[] | null = null;
    let ranked = false;
    const fts = ctx.signal.aborted ? null : getIndex();
    if (fts) {
      try {
        await fts.refresh({ home: opts.home, cwd: opts.cwd, allProjects: input.all_projects, excludeSessionId: current });
        results = fts.search(query, { source, projectDirs: dirs, excludeSessionId: current, limit });
        ranked = true;
      } catch {
        results = null; // a broken or locked index: the scan still answers
      }
    }
    results ??= await scanSearch(opts.home, dirs, words, source, limit, current, ctx.signal);

    const sections: string[] = [];
    let used = 0;
    let truncated = false;
    for (const r of results) {
      const section = formatResult(r, input.all_projects === true);
      if (used + section.length > MAX_OUTPUT_CHARS) {
        truncated = true;
        break;
      }
      used += section.length + 2;
      sections.push(section);
    }
    const what = source === "sessions" ? "past sessions" : source === "notes" ? "notes" : "past sessions or notes";
    if (sections.length === 0) return { content: `No ${what} match "${query}".`, summary: "no matches" };
    const n = sections.length;
    const order = ranked ? "best match first" : "newest first";
    const header = `${n} result${n === 1 ? "" : "s"} match "${query}" (${order}):`;
    const hint = '\n\nTo see more of a session, call SessionSearch with session_id and around=<#n>; for a day\'s notes, session_id=<date>.';
    const tail = truncated ? "\n\n(More results matched; output was cut at the size limit. Narrow the query.)" : "";
    return { content: `${header}\n\n${sections.join("\n\n")}${tail}${hint}`, summary: `${n} result${n === 1 ? "" : "s"}` };
  }

  return defineTool({
    name: "SessionSearch",
    kind: "read",
    description:
      "Search past conversations and daily notes in this project (or all projects with all_projects). " +
      'source picks "sessions", "notes" or "all" (default). Results are ranked by relevance and show the session id ' +
      "(or note date), date, title and up to 3 snippets, each with its message index #n. " +
      "Read mode: pass session_id (and optionally around=<#n>) instead of query to read that session's messages around " +
      "the index (5 either side, text only), or session_id=<YYYY-MM-DD> for that day's notes. " +
      "Use it to recall earlier decisions, fixes or user preferences; prefer a few distinctive words.",
    schema,
    summarize: (input) => {
      const scope = input.all_projects ? " (all projects)" : "";
      if (input.session_id) return `read ${input.session_id}${input.around !== undefined ? ` @${input.around}` : ""}${scope}`;
      const src = input.source && input.source !== "all" ? ` in ${input.source}` : "";
      return `"${input.query ?? ""}"${src}${scope}`;
    },
    // Other projects' conversations are outside this project: searching them asks, like any read out there.
    subject: (input) => ({ paths: input.all_projects ? [join(opts.home, "projects")] : [] }),
    async run(input, ctx) {
      try {
        if (input.session_id !== undefined) {
          const id = input.session_id.trim();
          const dirs = await projectDirs(opts.home, opts.cwd, input.all_projects);
          if (DATE.test(id)) return await readNotes(opts.home, dirs, id);
          if (!SESSION_ID.test(id)) return { content: "session_id must be a session id from a result or a date YYYY-MM-DD.", isError: true };
          return await readSession(dirs, id, input.around, input);
        }
        if (input.query === undefined) return { content: "Give a query to search, or a session_id to read.", isError: true };
        return await search(input, input.query, ctx);
      } catch (error) {
        return { content: `Session search failed: ${errorText(error)}`, isError: true };
      }
    },
  }) as AnyTool;
}
