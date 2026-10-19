// src/memory/notes.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { truncateMemoryText } from "../context/memory";
import { neutraliseHarnessTags } from "../context/tags";
import { resolveLayoutPath } from "../home/layout";
import { workspaceDir, workspaceFile } from "../paths";
import type { Ledger } from "../learning/ledger";
import { blockedPlaceholder, scanText } from "../learning/threats";
import type { Actor } from "../tools/types";
import { sectionEntries, withSectionEntries } from "./agents-file";

export type NotesTarget = "memory" | "user" | "lessons" | "heartbeat";

const ALL_TARGETS: readonly NotesTarget[] = ["memory", "user", "lessons", "heartbeat"];

/** Targets kept as items of a `## <section>` in the workspace AGENTS.md rather than in a file of their own. */
const SECTIONS = { lessons: "Lessons", heartbeat: "Heartbeat" } as const;
const sectionOf = (target: NotesTarget): "Lessons" | "Heartbeat" | undefined => (target === "lessons" || target === "heartbeat" ? SECTIONS[target] : undefined);

/**
 * Character budgets per store. They are deliberately small: the notes ride in every session's first
 * message, and a hard cap forces the model to consolidate instead of hoarding.
 */
export const MEMORY_LIMITS: Record<NotesTarget, number> = { memory: 2200, user: 1375, lessons: 2200, heartbeat: 2200 };

/** Entries are kept apart by a lone "§" line so a file stays readable and hand-editable. */
export const ENTRY_SEPARATOR = "\n§\n";

const FILES = { memory: "MEMORY.md", user: "USER.md" } as const;

const LABELS: Record<NotesTarget, string> = { memory: "agent notes", user: "user profile", lessons: "lessons", heartbeat: "heartbeat checks" };

/** Notes can hold personal facts: the directory and files are owner-only. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type NotesResult = { ok: true; entries: string[] } | { ok: false; error: string; entries: string[] };

/** One step of a Memory batch: the same shape as a single add / replace / remove call. */
export interface NotesOp {
  action: "add" | "replace" | "remove";
  content?: string;
  old_text?: string;
}

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
  return /(^|\n)[ \t]*§[ \t]*(\r?\n|$)/.test(text);
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
 * The agent's persistent notes (MEMORY.md), the user profile (USER.md) and the lessons (the Lessons section of
 * AGENTS.md) in the workspace (<home>/workspace).
 * Every change re-reads the file inside a per-store lock, so parallel tool calls don't lose writes.
 * New entry text is threat-scanned (notes ride into every later session), and with a ledger every
 * change is recorded so the user can see and undo it.
 */
export class NotesStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ledger?: Ledger;
  private readonly folder?: string;
  private readonly targets: readonly NotesTarget[];

  /** `dir` moves the store into another folder (a specialist's); `targets` limits which notes it holds. */
  constructor(
    private readonly home: string,
    opts: { ledger?: Ledger; dir?: string; targets?: NotesTarget[] } = {},
  ) {
    this.ledger = opts.ledger;
    this.folder = opts.dir;
    this.targets = opts.targets ?? ALL_TARGETS;
  }

  get dir(): string {
    return this.folder ?? workspaceDir(this.home);
  }

  allows(target: NotesTarget): boolean {
    return this.targets.includes(target);
  }

  path(target: NotesTarget): string {
    if (this.folder !== undefined) return join(this.folder, sectionOf(target) ? "AGENTS.md" : FILES[target as "memory" | "user"]);
    // Lessons are the "## Lessons" items of the workspace AGENTS.md, which has no legacy home.
    if (sectionOf(target)) return workspaceFile(this.home, "AGENTS.md");
    return resolveLayoutPath(this.home, FILES[target as "memory" | "user"]); // LEGACY_LAYOUT: memories/ until the migration moves it
  }

  async entries(target: NotesTarget): Promise<string[]> {
    const text = await this.readRaw(target);
    return text === null ? [] : parseEntries(target, text);
  }

  /** The file's text, or null when it doesn't exist. */
  private async readRaw(target: NotesTarget): Promise<string | null> {
    try {
      return await readFile(this.path(target), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  add(target: NotesTarget, content: string, actor?: Actor): Promise<NotesResult> {
    return this.change(target, "add", `add: ${clip(content)}`, actor, (entries) => applyOp(entries, { action: "add", content }, target));
  }

  replace(target: NotesTarget, oldText: string, content: string, actor?: Actor): Promise<NotesResult> {
    return this.change(target, "replace", `replace: ${clip(content)}`, actor, (entries) =>
      applyOp(entries, { action: "replace", old_text: oldText, content }, target),
    );
  }

  remove(target: NotesTarget, oldText: string, actor?: Actor): Promise<NotesResult> {
    return this.change(target, "remove", `remove: ${clip(oldText)}`, actor, (entries) =>
      applyOp(entries, { action: "remove", old_text: oldText }, target),
    );
  }

  /**
   * Applies several operations as one change: all of them or none. The size limit is checked only
   * on the result, so a store at its limit can be consolidated (remove three, add one merged entry).
   */
  batch(target: NotesTarget, ops: NotesOp[], actor?: Actor): Promise<NotesResult> {
    return this.change(target, "batch", `batch: ${ops.length} change${ops.length === 1 ? "" : "s"}`, actor, (entries) => {
      if (ops.length === 0) return "operations is empty.";
      let next = entries;
      for (const [i, op] of ops.entries()) {
        const result = applyOp(next, op, target);
        if (typeof result === "string") return `Operation ${i + 1} (${op.action}): ${result} Nothing was saved.`;
        next = result;
      }
      return next;
    });
  }

  /** Runs one read-modify-write under the lock; `edit` returns the new entries or an error message. */
  private change(
    target: NotesTarget,
    action: string,
    summary: string,
    actor: Actor | undefined,
    edit: (entries: string[]) => string[] | string,
  ): Promise<NotesResult> {
    const run = this.queue.then(async (): Promise<NotesResult> => {
      const path = this.path(target);
      const before = await this.readRaw(target);
      const entries = before === null ? [] : parseEntries(target, before);
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
      const section = sectionOf(target);
      const after = section ? withSectionEntries(before, section, next) : next.length > 0 ? `${next.join(ENTRY_SEPARATOR)}\n` : "";
      // Recorded before the write: if the write fails, undo sees a mismatch and refuses.
      await this.ledger?.record({
        actor: actor ?? "agent",
        kind: target === "user" ? "user" : "memory",
        path,
        action,
        summary,
        before,
        after,
      });
      await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
      await atomicWrite(path, after);
      return { ok: true, entries: next };
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** A store's entries: § -separated for the note files, the Lessons items for AGENTS.md. */
function parseEntries(target: NotesTarget, text: string): string[] {
  const section = sectionOf(target);
  return section ? sectionEntries(text, section) : splitEntries(text);
}

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One add / replace / remove applied to a list of entries: the new list or an error message. */
function applyOp(entries: string[], op: NotesOp, target: NotesTarget): string[] | string {
  if (op.action === "add") {
    if (op.content === undefined) return "add needs content.";
    const entry = op.content.trim();
    const invalid = checkEntry(entry);
    if (invalid) return invalid;
    if (entries.includes(entry)) return `That exact entry is already in the ${LABELS[target]}.`;
    return [...entries, entry];
  }
  if (op.old_text === undefined) return `${op.action} needs old_text.`;
  const found = findEntry(entries, op.old_text, target);
  if (typeof found === "string") return found;
  if (op.action === "remove") return entries.filter((_, i) => i !== found);
  if (op.content === undefined) return "replace needs content.";
  const entry = op.content.trim();
  const invalid = checkEntry(entry);
  if (invalid) return invalid;
  if (entries.some((e, i) => i !== found && e === entry)) return `That exact entry is already in the ${LABELS[target]}.`;
  return entries.map((e, i) => (i === found ? entry : e));
}

function checkEntry(entry: string): string | undefined {
  if (entry.length === 0) return "content is empty.";
  if (hasSeparatorLine(entry)) return 'content may not contain a line holding only "§"; that separates entries.';
  const scan = scanText(entry);
  if (!scan.ok) return `Refused: the entry looks unsafe (${scan.reason}). Notes are loaded into every future session, so they may not carry instructions, secrets or hidden characters.`;
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

const SOURCES: Record<NotesTarget, string> = { memory: "agent", user: "user-profile", lessons: "lessons", heartbeat: "heartbeat" };

/**
 * The notes blocks for a session's `<context>`; "" when both stores are empty. Entries that fail the
 * threat scan are replaced with a `[blocked: …]` placeholder and reported through `warn`.
 */
export async function notesContext(
  store: NotesStore,
  opts: { warn?: (message: string) => void; targets?: readonly NotesTarget[] } = {},
): Promise<string> {
  const parts: string[] = [];
  for (const target of opts.targets ?? ALL_TARGETS) {
    if (!store.allows(target)) continue;
    const entries = await store.entries(target);
    if (entries.length === 0) continue;
    const header = usageHeader(notesSize(entries), MEMORY_LIMITS[target]);
    // A file edited by hand (or before scanning existed) can still hold a bad entry: it is shown, not obeyed.
    const shown = entries.map((e) => {
      const scan = scanText(e);
      if (scan.ok) return e;
      opts.warn?.(`An entry in the ${LABELS[target]} was blocked: ${scan.reason} (${store.path(target)})`);
      return blockedPlaceholder(scan.reason);
    });
    // A hand edit can push a store over its cap; it is then cut like any oversized memory file instead of filling the prompt.
    const limit = MEMORY_LIMITS[target];
    const joined = shown.join(ENTRY_SEPARATOR);
    const body = joined.length > limit ? truncateMemoryText(store.path(target), joined, null, `${joined.length.toLocaleString("en-US")} chars`, limit) : joined;
    parts.push(`<notes source="${SOURCES[target]}">${header}\n${neutraliseNoteTags(body)}\n</notes>`);
  }
  return parts.join("\n");
}
