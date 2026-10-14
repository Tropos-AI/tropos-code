// src/memory/notes.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { neutraliseHarnessTags } from "../context/tags";

export type NotesTarget = "memory" | "user";

/**
 * Character budgets per store. They are deliberately small: the notes ride in every session's first
 * message, and a hard cap forces the model to consolidate instead of hoarding.
 */
export const MEMORY_LIMITS: Record<NotesTarget, number> = { memory: 2200, user: 1375 };

/** Entries are kept apart by a lone "§" line so a file stays readable and hand-editable. */
export const ENTRY_SEPARATOR = "\n§\n";

const FILES: Record<NotesTarget, string> = { memory: "MEMORY.md", user: "USER.md" };

const LABELS: Record<NotesTarget, string> = { memory: "agent notes", user: "user profile" };

/** Notes can hold personal facts: the directory and files are owner-only. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type NotesResult = { ok: true; entries: string[] } | { ok: false; error: string; entries: string[] };

export function notesLabel(target: NotesTarget): string {
  return LABELS[target];
}

/** Characters a list of entries occupies on disk, which is what the budget measures. */
export function notesSize(entries: string[]): number {
  return entries.join(ENTRY_SEPARATOR).length;
}

/** "[67% — 1,474/2,200 chars]" */
export function usageHeader(used: number, limit: number): string {
  const pct = Math.round((used / limit) * 100);
  return `[${pct}% — ${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars]`;
}

function splitEntries(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(ENTRY_SEPARATOR)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/** A "§" line inside an entry would split it in two on the next read. */
function hasSeparatorLine(text: string): boolean {
  return /(^|\n)[ \t]*§[ \t]*(\n|$)/.test(text);
}

/** Writes via a temp file and rename, so a crash or a concurrent reader never sees a half-written file. */
export async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { mode: FILE_MODE });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * The agent's persistent notes (MEMORY.md) and the user profile (USER.md) under <home>/memories.
 * Every change re-reads the file inside a per-store lock, so parallel tool calls don't lose writes.
 */
export class NotesStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly home: string) {}

  get dir(): string {
    return join(this.home, "memories");
  }

  path(target: NotesTarget): string {
    return join(this.dir, FILES[target]);
  }

  async entries(target: NotesTarget): Promise<string[]> {
    try {
      return splitEntries(await readFile(this.path(target), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  add(target: NotesTarget, content: string): Promise<NotesResult> {
    return this.change(target, (entries) => {
      const entry = content.trim();
      const invalid = checkEntry(entry);
      if (invalid) return invalid;
      if (entries.includes(entry)) return `That exact entry is already in the ${LABELS[target]}.`;
      return [...entries, entry];
    });
  }

  replace(target: NotesTarget, oldText: string, content: string): Promise<NotesResult> {
    return this.change(target, (entries) => {
      const found = findEntry(entries, oldText, target);
      if (typeof found === "string") return found;
      const entry = content.trim();
      const invalid = checkEntry(entry);
      if (invalid) return invalid;
      if (entries.some((e, i) => i !== found && e === entry)) return `That exact entry is already in the ${LABELS[target]}.`;
      return entries.map((e, i) => (i === found ? entry : e));
    });
  }

  remove(target: NotesTarget, oldText: string): Promise<NotesResult> {
    return this.change(target, (entries) => {
      const found = findEntry(entries, oldText, target);
      if (typeof found === "string") return found;
      return entries.filter((_, i) => i !== found);
    });
  }

  /** Runs one read-modify-write under the lock; `edit` returns the new entries or an error message. */
  private change(target: NotesTarget, edit: (entries: string[]) => string[] | string): Promise<NotesResult> {
    const run = this.queue.then(async (): Promise<NotesResult> => {
      const entries = await this.entries(target);
      const next = edit(entries);
      if (typeof next === "string") return { ok: false, error: next, entries };
      const limit = MEMORY_LIMITS[target];
      const size = notesSize(next);
      if (size > limit) {
        return {
          ok: false,
          error:
            `This would make the ${LABELS[target]} ${size.toLocaleString("en-US")} chars, over the ` +
            `${limit.toLocaleString("en-US")}-char limit. Consolidate or remove entries first.`,
          entries,
        };
      }
      await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
      await atomicWrite(this.path(target), next.length > 0 ? `${next.join(ENTRY_SEPARATOR)}\n` : "");
      return { ok: true, entries: next };
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

function checkEntry(entry: string): string | undefined {
  if (entry.length === 0) return "content is empty.";
  if (hasSeparatorLine(entry)) return 'content may not contain a line holding only "§"; that separates entries.';
  return undefined;
}

/** Index of the single entry containing `oldText`, or an error message. */
function findEntry(entries: string[], oldText: string, target: NotesTarget): number | string {
  if (oldText.trim().length === 0) return "old_text is empty; give a substring of the entry to change.";
  const hits = entries.flatMap((e, i) => (e.includes(oldText) ? [i] : []));
  if (hits.length === 0) return `No entry in the ${LABELS[target]} contains old_text.`;
  if (hits.length > 1) return `old_text matches ${hits.length} entries in the ${LABELS[target]}; use a longer, unique substring.`;
  return hits[0]!;
}

/**
 * Stops note text from opening or closing a wrapper tag of the first message (notes, context,
 * memory, environment, mode, reminders) by inserting a backslash after "<".
 */
export function neutraliseNoteTags(text: string): string {
  return neutraliseHarnessTags(text);
}

const SOURCES: Record<NotesTarget, string> = { memory: "agent", user: "user-profile" };

/** The notes blocks for a session's `<context>`; "" when both stores are empty. */
export async function notesContext(store: NotesStore): Promise<string> {
  const parts: string[] = [];
  for (const target of ["memory", "user"] as const) {
    const entries = await store.entries(target);
    if (entries.length === 0) continue;
    const header = usageHeader(notesSize(entries), MEMORY_LIMITS[target]);
    parts.push(`<notes source="${SOURCES[target]}">${header}\n${neutraliseNoteTags(entries.join(ENTRY_SEPARATOR))}\n</notes>`);
  }
  return parts.join("\n");
}
