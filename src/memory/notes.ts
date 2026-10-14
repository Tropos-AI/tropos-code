// src/memory/notes.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { neutraliseHarnessTags } from "../context/tags";
import type { Ledger } from "../learning/ledger";
import { blockedPlaceholder, scanText } from "../learning/threats";
import type { Actor } from "../tools/types";

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
 * New entry text is threat-scanned (notes ride into every later session), and with a ledger every
 * change is recorded so the user can see and undo it.
 */
export class NotesStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ledger?: Ledger;

  constructor(
    private readonly home: string,
    opts: { ledger?: Ledger } = {},
  ) {
    this.ledger = opts.ledger;
  }

  get dir(): string {
    return join(this.home, "memories");
  }

  path(target: NotesTarget): string {
    return join(this.dir, FILES[target]);
  }

  async entries(target: NotesTarget): Promise<string[]> {
    const text = await this.readRaw(target);
    return text === null ? [] : splitEntries(text);
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
      const before = await this.readRaw(target);
      const entries = before === null ? [] : splitEntries(before);
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
      const after = next.length > 0 ? `${next.join(ENTRY_SEPARATOR)}\n` : "";
      // Recorded before the write: if the write fails, undo sees a mismatch and refuses.
      await this.ledger?.record({
        actor: actor ?? "agent",
        kind: target === "memory" ? "memory" : "user",
        path: this.path(target),
        action,
        summary,
        before,
        after,
      });
      await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
      await atomicWrite(this.path(target), after);
      return { ok: true, entries: next };
    });
    this.queue = run.catch(() => {});
    return run;
  }
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

const SOURCES: Record<NotesTarget, string> = { memory: "agent", user: "user-profile" };

/**
 * The notes blocks for a session's `<context>`; "" when both stores are empty. Entries that fail the
 * threat scan are replaced with a `[blocked: …]` placeholder and reported through `warn`.
 */
export async function notesContext(
  store: NotesStore,
  opts: { warn?: (message: string) => void; targets?: readonly NotesTarget[] } = {},
): Promise<string> {
  const parts: string[] = [];
  for (const target of opts.targets ?? (["memory", "user"] as const)) {
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
    parts.push(`<notes source="${SOURCES[target]}">${header}\n${neutraliseNoteTags(shown.join(ENTRY_SEPARATOR))}\n</notes>`);
  }
  return parts.join("\n");
}
