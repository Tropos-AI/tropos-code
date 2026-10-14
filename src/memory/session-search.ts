// src/memory/session-search.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorText } from "../error-text";
import { projectDir, type MessageParam } from "../session/store";
import { defineTool, type AnyTool } from "../tools/types";

const schema = z.object({
  query: z.string().min(1).describe("Words to find; a message matches when it contains every word (case-insensitive)."),
  all_projects: z.boolean().optional().describe("Search sessions from every project, not just this one."),
  limit: z.number().int().min(1).max(20).optional().describe("Most sessions to return (default 10, at most 20)."),
});

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** Transcripts can grow large; a file past this is skipped rather than loaded into memory. */
export const MAX_SESSION_BYTES = 50 * 1024 * 1024;
const DEFAULT_LIMIT = 10;
const SNIPPETS_PER_SESSION = 3;
const SNIPPET_RADIUS = 200;
/** Keeps one search from flooding the context window. */
export const MAX_OUTPUT_CHARS = 20_000;

/** Text blocks that are harness scaffolding (memory files, mode notes), not something the user typed. */
const SCAFFOLD = /^\s*<(context|mode|reminder|hook-context)>/;

interface Candidate {
  id: string;
  path: string;
  mtime: Date;
}

interface Hit {
  role: "user" | "assistant";
  snippet: string;
}

interface SessionHits {
  id: string;
  title: string;
  date: Date;
  cwd?: string;
  hits: Hit[];
}

async function sessionFiles(dir: string): Promise<Candidate[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: Candidate[] = [];
  for (const name of names) {
    if (!SESSION_FILE.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_SESSION_BYTES) continue;
      out.push({ id: name.slice(0, -".jsonl".length), path, mtime: info.mtime });
    } catch {
      continue; // vanished between readdir and stat
    }
  }
  return out;
}

/** The typed text of a message: string content or text blocks; thinking, tool calls and tool results are left out. */
function messageTexts(message: MessageParam): string[] {
  if (typeof message.content === "string") return [message.content];
  if (!Array.isArray(message.content)) return [];
  const out: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") out.push(block.text);
  }
  return out;
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

function searchText(text: string, words: string[]): SessionHits | null {
  const result: SessionHits = { id: "", title: "(untitled)", date: new Date(0), hits: [] };
  const safe = words.filter(rawSafe);
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const isMeta = raw.startsWith('{"type":"meta"');
    if (!isMeta) {
      if (result.hits.length >= SNIPPETS_PER_SESSION) continue;
      const lower = raw.toLowerCase();
      if (!safe.every((w) => lower.includes(w))) continue;
    }
    let line: { type?: unknown; title?: unknown; cwd?: unknown; createdAt?: unknown; message?: MessageParam };
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // a line cut short by a crash
    }
    if (typeof line !== "object" || line === null) continue;
    if (line.type === "meta") {
      if (typeof line.title === "string") result.title = line.title;
      if (typeof line.cwd === "string") result.cwd = line.cwd;
      continue;
    }
    const message = line.message;
    if (line.type !== "message" || typeof message !== "object" || message === null) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    for (const t of messageTexts(message)) {
      if (result.hits.length >= SNIPPETS_PER_SESSION) break;
      if (message.role === "user" && SCAFFOLD.test(t)) continue;
      const lower = t.toLowerCase();
      if (words.every((w) => lower.includes(w))) result.hits.push({ role: message.role, snippet: snippet(t, words) });
    }
  }
  return result.hits.length > 0 ? result : null;
}

function formatSession(s: SessionHits, showProject: boolean): string {
  const date = s.date.toISOString().slice(0, 10);
  const head = `## ${s.title} (${s.id}, ${date}${showProject && s.cwd ? `, ${s.cwd}` : ""})`;
  return [head, ...s.hits.map((h) => `- [${h.role}] ${h.snippet}`)].join("\n");
}

/**
 * SessionSearch: finds earlier conversations by keyword so the model can recall what was decided or
 * done before. Plain substring matching over the JSONL transcripts, newest session first.
 */
export function createSessionSearchTool(opts: { home: string; cwd: string; currentSessionId?: () => string }): AnyTool {
  return defineTool({
    name: "SessionSearch",
    kind: "read",
    description:
      "Search past conversations in this project (or all projects with all_projects) for messages containing every word of " +
      "the query, case-insensitive. Returns the newest matching sessions with their id, date, title and up to 3 short " +
      "snippets each. Use it to recall earlier decisions, fixes or user preferences; prefer a few distinctive words.",
    schema,
    summarize: (input) => `"${input.query}"${input.all_projects ? " (all projects)" : ""}`,
    // Other projects' conversations are outside this project: searching them asks, like any read out there.
    subject: (input) => ({ paths: input.all_projects ? [join(opts.home, "projects")] : [] }),
    async run(input, ctx) {
      const words = [...new Set(input.query.toLowerCase().split(/\s+/).filter(Boolean))];
      if (words.length === 0) return { content: "query has no words to search for.", isError: true };
      const limit = input.limit ?? DEFAULT_LIMIT;
      const current = opts.currentSessionId?.();
      try {
        let dirs: string[];
        if (input.all_projects) {
          const root = join(opts.home, "projects");
          dirs = (await readdir(root).catch(() => [] as string[])).map((name) => join(root, name));
        } else {
          dirs = [projectDir(opts.home, opts.cwd)];
        }
        const candidates = (await Promise.all(dirs.map(sessionFiles)))
          .flat()
          .filter((c) => c.id !== current)
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        const sections: string[] = [];
        let used = 0;
        let truncated = false;
        for (const c of candidates) {
          if (ctx.signal.aborted || sections.length >= limit) break;
          let text: string;
          try {
            text = await readFile(c.path, "utf8");
          } catch {
            continue; // unreadable or removed meanwhile
          }
          const found = searchText(text, words);
          if (!found) continue;
          found.id = c.id;
          found.date = c.mtime;
          const section = formatSession(found, input.all_projects === true);
          if (used + section.length > MAX_OUTPUT_CHARS) {
            truncated = true;
            break;
          }
          used += section.length + 2;
          sections.push(section);
        }
        if (sections.length === 0) {
          return { content: `No past sessions match "${input.query}".`, summary: "no matches" };
        }
        const n = sections.length;
        const header = `${n} session${n === 1 ? "" : "s"} match "${input.query}" (newest first):`;
        const tail = truncated ? "\n\n(More sessions matched; output was cut at the size limit. Narrow the query.)" : "";
        return { content: `${header}\n\n${sections.join("\n\n")}${tail}`, summary: `${n} session${n === 1 ? "" : "s"}` };
      } catch (error) {
        return { content: `Session search failed: ${errorText(error)}`, isError: true };
      }
    },
  }) as AnyTool;
}
