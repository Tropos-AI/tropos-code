// src/tools/read-state.ts
export type ReadCheck = "ok" | "unread" | "stale";

/** Remembers the mtime of every file the model has read, so writes can't clobber unseen changes. */
export class ReadState {
  private readonly seen = new Map<string, number>();

  record(path: string, mtimeMs: number): void {
    this.seen.set(path, mtimeMs);
  }

  check(path: string, mtimeMs: number): ReadCheck {
    const seen = this.seen.get(path);
    if (seen === undefined) return "unread";
    return seen === mtimeMs ? "ok" : "stale";
  }
}
