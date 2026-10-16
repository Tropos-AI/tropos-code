// src/exec/git-integrity.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absentCommondirs, COMMONDIR_TAMPERED, type CommondirSnapshot, commondirSnapshot, commondirUnsafe, enforceCommondir } from "./git-integrity";

let fx: string;
let git: string;
let outside: string;
beforeEach(() => {
  fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-gi-")));
  git = join(fx, "ws", ".git");
  outside = join(fx, "outside");
  mkdirSync(git, { recursive: true });
  mkdirSync(outside);
});
afterEach(() => rmSync(fx, { recursive: true, force: true }));

const gone = (p: string) => {
  try {
    lstatSync(p);
    return false;
  } catch {
    return true;
  }
};
const snapshot = (dirs = [git]): CommondirSnapshot => {
  const snap = commondirSnapshot(git, dirs);
  if (!snap) throw new Error("no snapshot");
  return snap;
};

test("a commondir file created during a command is unlinked and the command is to be failed", () => {
  const snap = snapshot();
  expect(absentCommondirs(snap)).toEqual([join(git, "commondir")]);
  writeFileSync(join(git, "commondir"), "x");
  expect(enforceCommondir(snap)).toEqual({ removed: [join(git, "commondir")], unsafe: [], message: COMMONDIR_TAMPERED });
  expect(existsSync(join(git, "commondir"))).toBe(false);
});

test("a dangling symlink planted as commondir is detected and only the link is removed", () => {
  const snap = snapshot();
  writeFileSync(join(outside, "target"), "keep");
  symlinkSync(join(outside, "target"), join(git, "commondir"));
  expect(enforceCommondir(snap).message).toBe(COMMONDIR_TAMPERED);
  expect(gone(join(git, "commondir"))).toBe(true);
  expect(readFileSync(join(outside, "target"), "utf8")).toBe("keep");
  symlinkSync(join(fx, "nowhere"), join(git, "commondir"));
  expect(enforceCommondir(snap).removed).toEqual([join(git, "commondir")]);
});

test("a commondir planted as a directory is left in place and reported, never deleted recursively", () => {
  const snap = snapshot();
  mkdirSync(join(git, "commondir"));
  writeFileSync(join(git, "commondir", "f"), "x");
  const r = enforceCommondir(snap);
  expect(r).toEqual({ removed: [], unsafe: [join(git, "commondir")], message: commondirUnsafe(join(git, "commondir")) });
  expect(existsSync(join(git, "commondir", "f"))).toBe(true);
});

test("a parent swapped for a link to an outside dir: nothing outside is touched, the command is failed", () => {
  const sub = join(git, "modules", "lib");
  mkdirSync(sub, { recursive: true });
  const snap = snapshot([git, sub]);
  // The command replaces .git/modules/lib with a link to a host dir that has its own commondir.
  writeFileSync(join(outside, "commondir"), "precious");
  renameSync(sub, join(git, "modules", "old"));
  symlinkSync(outside, sub);
  const r = enforceCommondir(snap);
  expect(r.removed).toEqual([]);
  expect(r.unsafe).toEqual([join(sub, "commondir")]);
  expect(r.message).toBe(commondirUnsafe(join(sub, "commondir")));
  expect(readFileSync(join(outside, "commondir"), "utf8")).toBe("precious");
});

test("a commondir that was already there (a real linked worktree) is left alone", () => {
  writeFileSync(join(git, "commondir"), "../..");
  const snap = snapshot();
  expect(absentCommondirs(snap)).toEqual([]);
  expect(enforceCommondir(snap)).toEqual({ removed: [], unsafe: [], message: null });
  expect(existsSync(join(git, "commondir"))).toBe(true);
});

test("every git dir is checked, so a submodule's commondir is caught too", () => {
  const sub = join(git, "modules", "lib");
  mkdirSync(sub, { recursive: true });
  const snap = snapshot([git, sub]);
  writeFileSync(join(sub, "commondir"), "x");
  expect(enforceCommondir(snap)).toEqual({ removed: [join(sub, "commondir")], unsafe: [], message: COMMONDIR_TAMPERED });
});

test("no snapshot without a real .git directory", () => {
  rmSync(git, { recursive: true });
  expect(commondirSnapshot(git, [git])).toBeNull();
  symlinkSync(outside, git);
  expect(commondirSnapshot(git, [git])).toBeNull();
});
