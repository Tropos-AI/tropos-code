// src/snapshots/undo.ts
import type { SnapshotStore } from "./store";

export type UndoResult = { ok: true; files: string[] } | { ok: false; reason: string };

/** Files named in one reminder; the rest are counted, so a mass revert can't flood the prompt. */
const REMINDER_FILE_LIMIT = 50;

export const NO_STORE_REASON = "Snapshots are off: this directory is not inside a git repository (or git is not installed).";

/** A pre-turn tree, or null for a turn whose snapshot failed or timed out (un-undoable). */
type UndoEntry = string | null;

interface RedoEntry {
  /** The state the undo replaced; redo restores it. */
  after: string;
  /** The pre-turn tree the undo restored; redo puts it back on the undo stack. */
  before: string;
}

/**
 * The per-session undo/redo stacks over a SnapshotStore. History is append-only: undo
 * reverts files, never messages, and the model hears about it through a one-shot reminder.
 */
export class UndoManager {
  private readonly store: SnapshotStore | null;
  private readonly undoStack: UndoEntry[] = [];
  private redoStack: RedoEntry[] = [];
  /** The current turn's recording, shared by every tool call in it (tools may run in parallel). */
  private recording: Promise<void> | null = null;
  private pendingFiles = new Set<string>();
  private pendingKinds = new Set<"undo" | "redo">();
  /** Serializes undo/redo/record so stack updates never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: SnapshotStore | null) {
    this.store = store;
  }

  /** Marks a new user turn. Nothing is recorded until the turn's first edit or exec tool. */
  beginTurn(): void {
    this.recording = null;
  }

  /**
   * Called before every edit/exec tool; records the pre-turn tree once per turn. Concurrent callers
   * in the same turn all wait for that one recording, so no tool edits before the snapshot exists.
   * Recording clears the redo stack: once a new turn may change files, an old redo would clobber them.
   */
  beforeChange(): Promise<void> {
    if (this.store === null) return Promise.resolve();
    this.recording ??= this.serialize(async () => {
      const tree = await this.store!.track();
      this.undoStack.push(tree);
      this.redoStack = [];
    });
    return this.recording;
  }

  /**
   * Restores the most recent pre-turn tree not yet undone. Entries whose turn changed nothing are
   * skipped. The current state is tracked first so redo can return to it.
   */
  undo(): Promise<UndoResult> {
    return this.serialize(async (): Promise<UndoResult> => {
      const store = this.store;
      if (store === null) return { ok: false, reason: NO_STORE_REASON };
      if (this.undoStack.length === 0) return { ok: false, reason: "Nothing to undo" };
      const current = await store.track();
      if (current === null) return { ok: false, reason: "Could not record the current files (git failed or took over 10 s); nothing was restored." };
      while (this.undoStack.length > 0) {
        const target = this.undoStack.pop()!;
        if (target === null) {
          return {
            ok: false,
            reason: "The last turn's files were not snapshotted (git failed or took over 10 s), so it cannot be undone. Run /undo again to go further back.",
          };
        }
        let files: string[];
        try {
          files = await store.restore(target);
        } catch (err) {
          this.undoStack.push(target);
          return { ok: false, reason: `Undo failed: ${errorText(err)}` };
        }
        if (files.length === 0) continue; // that turn changed nothing
        this.redoStack.push({ after: current, before: target });
        this.note("undo", files);
        return { ok: true, files };
      }
      return { ok: false, reason: "Nothing to undo" };
    });
  }

  /** Re-applies the most recent undo, unless a later turn has recorded changes since. */
  redo(): Promise<UndoResult> {
    return this.serialize(async (): Promise<UndoResult> => {
      const store = this.store;
      if (store === null) return { ok: false, reason: NO_STORE_REASON };
      const entry = this.redoStack.pop();
      if (entry === undefined) return { ok: false, reason: "Nothing to redo" };
      let files: string[];
      try {
        files = await store.restore(entry.after);
      } catch (err) {
        this.redoStack.push(entry);
        return { ok: false, reason: `Redo failed: ${errorText(err)}` };
      }
      this.undoStack.push(entry.before);
      this.note("redo", files);
      return { ok: true, files };
    });
  }

  /** The reminder for the next prompt after an undo/redo, then null until the next one. */
  takeReminder(): string | null {
    if (this.pendingKinds.size === 0) return null;
    const files = [...this.pendingFiles].sort();
    const shown = files.slice(0, REMINDER_FILE_LIMIT).join(", ");
    const list = files.length > REMINDER_FILE_LIMIT ? `${shown} and ${files.length - REMINDER_FILE_LIMIT} more` : shown;
    const what =
      this.pendingKinds.size === 2
        ? "The user undid and redid file changes from the last turn(s)"
        : this.pendingKinds.has("undo")
          ? "The user undid your file changes from the last turn(s)"
          : "The user redid file changes they had undone";
    this.pendingFiles = new Set();
    this.pendingKinds = new Set();
    return `<reminder>${what}: ${list || "(no files)"}. Re-read before editing.</reminder>`;
  }

  private note(kind: "undo" | "redo", files: string[]): void {
    this.pendingKinds.add(kind);
    for (const f of files) this.pendingFiles.add(f);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
