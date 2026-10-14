// src/snapshots/undo.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { SnapshotStore } from "./store";
import { makeRepo } from "./test-repo";
import { NO_STORE_REASON, UndoManager } from "./undo";

let repo: string;
let home: string;
let store: SnapshotStore;
let undo: UndoManager;

beforeEach(async () => {
  repo = await makeRepo();
  home = await makeTmpDir("tropos-undo-home-");
  store = (await SnapshotStore.open(home, repo))!;
  undo = new UndoManager(store);
});

afterEach(async () => {
  await removeDir(repo);
  await removeDir(home);
});

const read = (p: string) => readFileSync(join(repo, p), "utf8");
const write = (p: string, s: string) => writeFileSync(join(repo, p), s);

/** One agent turn that edits files. */
async function turn(edit: () => void): Promise<void> {
  undo.beginTurn();
  await undo.beforeChange();
  edit();
}

describe("UndoManager", () => {
  test("nothing to undo or redo on a fresh session", async () => {
    expect(await undo.undo()).toEqual({ ok: false, reason: "Nothing to undo" });
    expect(await undo.redo()).toEqual({ ok: false, reason: "Nothing to redo" });
    expect(undo.takeReminder()).toBeNull();
  });

  test("without a store, undo and redo explain that snapshots are off", async () => {
    const off = new UndoManager(null);
    off.beginTurn();
    await off.beforeChange();
    expect(await off.undo()).toEqual({ ok: false, reason: NO_STORE_REASON });
    expect(await off.redo()).toEqual({ ok: false, reason: NO_STORE_REASON });
  });

  test("undo walks back turn by turn and redo walks forward", async () => {
    await turn(() => write("a.txt", "two\n"));
    await turn(() => {
      write("a.txt", "three\n");
      write("b.txt", "b\n");
    });

    expect(await undo.undo()).toEqual({ ok: true, files: ["a.txt", "b.txt"] });
    expect(read("a.txt")).toBe("two\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);

    expect(await undo.undo()).toEqual({ ok: true, files: ["a.txt"] });
    expect(read("a.txt")).toBe("one\n");
    expect(await undo.undo()).toEqual({ ok: false, reason: "Nothing to undo" });

    expect(await undo.redo()).toEqual({ ok: true, files: ["a.txt"] });
    expect(read("a.txt")).toBe("two\n");
    expect(await undo.redo()).toEqual({ ok: true, files: ["a.txt", "b.txt"] });
    expect(read("a.txt")).toBe("three\n");
    expect(read("b.txt")).toBe("b\n");
    expect(await undo.redo()).toEqual({ ok: false, reason: "Nothing to redo" });

    // Redone turns can be undone again.
    expect(await undo.undo()).toEqual({ ok: true, files: ["a.txt", "b.txt"] });
    expect(read("a.txt")).toBe("two\n");
  });

  test("a new turn that records a change clears the redo stack", async () => {
    await turn(() => write("a.txt", "two\n"));
    expect((await undo.undo()).ok).toBe(true);
    await turn(() => write("c.txt", "c\n"));
    expect(await undo.redo()).toEqual({ ok: false, reason: "Nothing to redo" });
    expect(await undo.undo()).toEqual({ ok: true, files: ["c.txt"] });
    expect(read("a.txt")).toBe("one\n");
  });

  test("turns without edit/exec tools record nothing; a turn records once", async () => {
    undo.beginTurn(); // read-only turn
    undo.beginTurn();
    await Promise.all([undo.beforeChange(), undo.beforeChange()]);
    write("a.txt", "two\n");
    await undo.beforeChange(); // same turn: no second snapshot
    write("a.txt", "three\n");
    expect(await undo.undo()).toEqual({ ok: true, files: ["a.txt"] });
    expect(read("a.txt")).toBe("one\n");
    expect(await undo.undo()).toEqual({ ok: false, reason: "Nothing to undo" });
  });

  test("turns that changed nothing are skipped", async () => {
    await turn(() => write("a.txt", "two\n"));
    await turn(() => {}); // exec that changed nothing
    expect(await undo.undo()).toEqual({ ok: true, files: ["a.txt"] });
    expect(read("a.txt")).toBe("one\n");
  });

  test("an un-undoable turn is reported, then undo continues further back", async () => {
    await turn(() => write("a.txt", "two\n"));
    // Break the store so the next turn's snapshot fails.
    const objects = join(store.dir, "objects");
    const saved = join(home, "objects-saved");
    renameSync(objects, saved);
    writeFileSync(objects, "broken");
    write("a.txt", "three\n");
    undo.beginTurn();
    await undo.beforeChange();
    rmSync(objects);
    renameSync(saved, objects);

    const first = await undo.undo();
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toContain("cannot be undone");
    expect(read("a.txt")).toBe("three\n");
    expect(await undo.undo()).toEqual({ ok: true, files: ["a.txt"] });
    expect(read("a.txt")).toBe("one\n");
  });

  test("undo fails cleanly when the current state cannot be recorded", async () => {
    await turn(() => write("a.txt", "two\n"));
    const objects = join(store.dir, "objects");
    const saved = join(home, "objects-saved");
    renameSync(objects, saved);
    writeFileSync(objects, "broken");
    const r = await undo.undo();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Could not record");
    expect(read("a.txt")).toBe("two\n");
  });

  test("restore errors surface as failed results and keep the stacks", async () => {
    const fake = {
      track: async () => "t-now",
      restore: async (_tree: string): Promise<string[]> => {
        throw new Error("disk on fire");
      },
    } as unknown as SnapshotStore;
    const m = new UndoManager(fake);
    m.beginTurn();
    await m.beforeChange();
    expect(await m.undo()).toEqual({ ok: false, reason: "Undo failed: disk on fire" });
    // The entry is kept, so a retry fails the same way rather than skipping it.
    expect(await m.undo()).toEqual({ ok: false, reason: "Undo failed: disk on fire" });

    let fail = false;
    const flaky = {
      track: async () => "t",
      restore: async (): Promise<string[]> => {
        if (fail) throw "nope";
        return ["x"];
      },
    } as unknown as SnapshotStore;
    const n = new UndoManager(flaky);
    n.beginTurn();
    await n.beforeChange();
    expect((await n.undo()).ok).toBe(true);
    fail = true;
    expect(await n.redo()).toEqual({ ok: false, reason: "Redo failed: nope" });
    fail = false;
    expect(await n.redo()).toEqual({ ok: true, files: ["x"] });
  });

  describe("takeReminder", () => {
    test("one-shot reminder after undo naming the files", async () => {
      await turn(() => {
        write("a.txt", "two\n");
        write("new file.txt", "n\n");
      });
      await undo.undo();
      expect(undo.takeReminder()).toBe(
        "<reminder>The user undid your file changes from the last turn(s): a.txt, new file.txt. Re-read before editing.</reminder>",
      );
      expect(undo.takeReminder()).toBeNull();
    });

    test("redo and mixed undo+redo wording", async () => {
      await turn(() => write("a.txt", "two\n"));
      await undo.undo();
      undo.takeReminder();
      await undo.redo();
      expect(undo.takeReminder()).toBe("<reminder>The user redid file changes they had undone: a.txt. Re-read before editing.</reminder>");
      await undo.undo();
      await undo.redo();
      expect(undo.takeReminder()).toBe(
        "<reminder>The user undid and redid file changes from the last turn(s): a.txt. Re-read before editing.</reminder>",
      );
    });

    test("caps the file list", async () => {
      await turn(() => {
        for (let i = 0; i < 55; i++) write(`f${String(i).padStart(2, "0")}.txt`, "x\n");
      });
      await undo.undo();
      const text = undo.takeReminder()!;
      expect(text).toContain("f49.txt and 5 more. Re-read before editing.");
      expect(text).not.toContain("f50.txt");
    });

    test("no reminder after a failed undo", async () => {
      await undo.undo();
      expect(undo.takeReminder()).toBeNull();
    });
  });
});
