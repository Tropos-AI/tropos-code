// src/exec/git-integrity.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absentCommondirs, COMMONDIR_TAMPERED, commondirSnapshot, enforceCommondir } from "./git-integrity";

let fx: string;
let git: string;
beforeEach(() => {
  fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-gi-")));
  git = join(fx, ".git");
  mkdirSync(git, { recursive: true });
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

test("a commondir created during a command is removed and the command is to be failed", () => {
  const before = commondirSnapshot([git]);
  expect(before.size).toBe(0);
  expect(absentCommondirs([git])).toEqual([join(git, "commondir")]);
  writeFileSync(join(git, "commondir"), "x");
  expect(enforceCommondir([git], before)).toEqual({ removed: [join(git, "commondir")], message: COMMONDIR_TAMPERED });
  expect(existsSync(join(git, "commondir"))).toBe(false);
});

test("a dangling symlink planted as commondir is detected and removed", () => {
  const before = commondirSnapshot([git]);
  symlinkSync(join(fx, "nowhere"), join(git, "commondir"));
  expect(existsSync(join(git, "commondir"))).toBe(false); // stat can't see it
  expect(enforceCommondir([git], before).message).toBe(COMMONDIR_TAMPERED);
  expect(gone(join(git, "commondir"))).toBe(true);
});

test("a commondir planted as a directory is removed too", () => {
  const before = commondirSnapshot([git]);
  mkdirSync(join(git, "commondir"));
  expect(enforceCommondir([git], before).removed).toEqual([join(git, "commondir")]);
  expect(gone(join(git, "commondir"))).toBe(true);
});

test("a commondir that was already there (a real linked worktree) is left alone", () => {
  writeFileSync(join(git, "commondir"), "../..");
  const before = commondirSnapshot([git]);
  expect(before.has(join(git, "commondir"))).toBe(true);
  expect(enforceCommondir([git], before)).toEqual({ removed: [], message: null });
  expect(existsSync(join(git, "commondir"))).toBe(true);
});

test("every git dir is checked, so a submodule's commondir is caught too", () => {
  const sub = join(git, "modules", "lib");
  mkdirSync(sub, { recursive: true });
  const before = commondirSnapshot([git, sub]);
  writeFileSync(join(sub, "commondir"), "x");
  expect(enforceCommondir([git, sub], before)).toEqual({ removed: [join(sub, "commondir")], message: COMMONDIR_TAMPERED });
});
