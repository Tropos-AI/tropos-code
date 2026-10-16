// src/exec/git-integrity.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  absentCommondirs,
  COMMONDIR_TAMPERED,
  type CommondirSnapshot,
  commondirSnapshot,
  commondirUnsafe,
  enforceCommondir,
  enforceNewGitDirs,
  findNestedGitDirs,
  GIT_METADATA_TAMPERED,
  gitDirsSnapshot,
  gitMetadataUnsafe,
} from "./git-integrity";

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

/** A git dir (it has a HEAD) with a hook and a config, as a command could plant one. */
const plantGitDir = (dir: string) => {
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, "hooks", "post-checkout"), "#!/bin/sh\nevil");
  writeFileSync(join(dir, "config"), "[core]\n\tfsmonitor = evil");
};

test("nested git dirs are found under modules (path segments included) and worktrees, never through a link", () => {
  plantGitDir(join(git, "modules", "lib"));
  plantGitDir(join(git, "modules", "libs", "foo"));
  plantGitDir(join(git, "modules", "lib", "modules", "inner"));
  plantGitDir(join(git, "worktrees", "wt"));
  mkdirSync(join(git, "modules", "lib", "objects", "ab"), { recursive: true });
  writeFileSync(join(git, "modules", "lib", "objects", "ab", "HEAD"), "not a git dir: inside a git dir only modules/ and worktrees/ are searched");
  symlinkSync(outside, join(git, "modules", "linked"));
  const found = findNestedGitDirs(git);
  expect(found.gitDirs.sort()).toEqual([join(git, "modules", "lib"), join(git, "modules", "lib", "modules", "inner"), join(git, "modules", "libs", "foo"), join(git, "worktrees", "wt")].sort());
  expect(found.links).toEqual([join(git, "modules", "linked")]);
  expect(found.deep).toEqual([]);
});

test("a git dir created during the command loses its hooks and config, and the command is to be failed", () => {
  plantGitDir(join(git, "modules", "old"));
  const snap = gitDirsSnapshot(git);
  if (!snap) throw new Error("no snapshot");
  expect(snap.gitDirs).toEqual([join(git, "modules", "old")]);
  const fresh = join(git, "modules", "new");
  plantGitDir(fresh);
  writeFileSync(join(fresh, "commondir"), "/elsewhere");
  writeFileSync(join(fresh, "config.worktree"), "x");
  const r = enforceNewGitDirs(snap);
  expect(r.message).toBe(GIT_METADATA_TAMPERED);
  expect(r.unsafe).toEqual([]);
  expect(r.removed.sort()).toEqual(["commondir", "config", "config.worktree", "hooks"].map((n) => join(fresh, n)).sort());
  expect(readdirSync(fresh)).toEqual(["HEAD"]);
  // The git dir that was there before is untouched.
  expect(existsSync(join(git, "modules", "old", "hooks", "post-checkout"))).toBe(true);
  expect(existsSync(join(git, "modules", "old", "config"))).toBe(true);
  expect(enforceNewGitDirs(snap)).toEqual({ removed: [], unsafe: [], message: null });
});

test("a link planted under modules is removed, never followed; a directory inside hooks is left and reported", () => {
  const snap = gitDirsSnapshot(git)!;
  writeFileSync(join(outside, "keep"), "precious");
  symlinkSync(outside, join(git, "modules"));
  let r = enforceNewGitDirs(snap);
  expect(r).toEqual({ removed: [join(git, "modules")], unsafe: [], message: GIT_METADATA_TAMPERED });
  expect(gone(join(git, "modules"))).toBe(true);
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("precious");

  const fresh = join(git, "worktrees", "wt");
  plantGitDir(fresh);
  mkdirSync(join(fresh, "hooks", "nested"));
  writeFileSync(join(fresh, "hooks", "nested", "f"), "x");
  r = enforceNewGitDirs(snap);
  expect(r.unsafe).toEqual([join(fresh, "hooks", "nested")]);
  expect(r.message).toBe(gitMetadataUnsafe(join(fresh, "hooks", "nested")));
  expect(existsSync(join(fresh, "hooks", "nested", "f"))).toBe(true); // never deleted recursively
  expect(existsSync(join(fresh, "hooks", "post-checkout"))).toBe(false);
  expect(existsSync(join(fresh, "config"))).toBe(false);
});

test("git dirs nested beyond the search depth are reported, not silently skipped", () => {
  const snap = gitDirsSnapshot(git)!;
  let deep = join(git, "modules");
  for (let i = 0; i < 12; i++) deep = join(deep, `d${i}`);
  plantGitDir(deep);
  const r = enforceNewGitDirs(snap);
  expect(r.removed).toEqual([]);
  expect(r.unsafe.length).toBe(1);
  expect(r.message).toBe(gitMetadataUnsafe(r.unsafe[0]!));
  expect(existsSync(join(deep, "config"))).toBe(true);
});

test("a modules dir replaced by a link is caught: the link goes, the moved dir and the target stay", () => {
  plantGitDir(join(git, "modules", "lib"));
  const snap = gitDirsSnapshot(git)!;
  renameSync(join(git, "modules"), join(git, "modules-old"));
  plantGitDir(join(outside, "lib"));
  symlinkSync(outside, join(git, "modules"));
  expect(enforceNewGitDirs(snap)).toEqual({ removed: [join(git, "modules")], unsafe: [], message: GIT_METADATA_TAMPERED });
  expect(gone(join(git, "modules"))).toBe(true);
  expect(existsSync(join(outside, "lib", "hooks", "post-checkout"))).toBe(true);
  // A link that was already there before the command is the owner's: left alone.
  symlinkSync(outside, join(git, "worktrees"));
  const withLink = gitDirsSnapshot(git)!;
  expect(enforceNewGitDirs(withLink)).toEqual({ removed: [], unsafe: [], message: null });
  expect(lstatSync(join(git, "worktrees")).isSymbolicLink()).toBe(true);
});
