// src/exec/git-integrity.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  GIT_LINK_REMOVED,
  GIT_METADATA_TAMPERED,
  gitDirsSnapshot,
  gitMetadataUnsafe,
  writableLinks,
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
  expect(found.unreadable).toEqual([]);
  expect(found.overflow).toBe(false);
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
  // The hooks dir is moved aside into a quarantine in .git (out of git's reach) and emptied there; the directory
  // inside it is left there and reported.
  expect(r.unsafe).toHaveLength(1);
  const leftover = r.unsafe[0]!;
  expect(leftover).toMatch(new RegExp(`^${git}/\\.tropos-quarantine-[^/]+/\\d+/nested$`));
  expect(r.message).toBe(gitMetadataUnsafe(leftover));
  expect(readFileSync(join(leftover, "f"), "utf8")).toBe("x"); // never deleted recursively
  expect(existsSync(join(fresh, "hooks"))).toBe(false);
  expect(existsSync(join(fresh, "config"))).toBe(false);
});

test("the quarantine sits in the main .git/hooks when that is a real dir, and is gone when everything was removed", () => {
  mkdirSync(join(git, "hooks"));
  writeFileSync(join(git, "hooks", "pre-commit"), "owner's hook");
  const snap = gitDirsSnapshot(git)!;
  const fresh = join(git, "modules", "lib");
  plantGitDir(fresh);
  mkdirSync(join(fresh, "hooks", "nested"));
  let r = enforceNewGitDirs(snap);
  expect(r.unsafe).toHaveLength(1);
  expect(r.unsafe[0]).toMatch(new RegExp(`^${git}/hooks/\\.tropos-quarantine-[^/]+/\\d+/nested$`));
  rmSync(join(git, "hooks", readdirSync(join(git, "hooks")).find((n) => n.startsWith(".tropos-quarantine-"))!), { recursive: true });
  plantGitDir(join(git, "modules", "other"));
  r = enforceNewGitDirs(snap);
  expect(r).toMatchObject({ unsafe: [], message: GIT_METADATA_TAMPERED });
  expect(readdirSync(join(git, "hooks"))).toEqual(["pre-commit"]);
  expect(readdirSync(git).filter((n) => n.startsWith(".tropos-quarantine-"))).toEqual([]);
});

test("git dirs nested at any depth are found and swept (no depth limit)", () => {
  const snap = gitDirsSnapshot(git)!;
  let deep = join(git, "modules");
  for (let i = 0; i < 40; i++) deep = join(deep, `d${i}`);
  plantGitDir(deep);
  const r = enforceNewGitDirs(snap);
  expect(r.message).toBe(GIT_METADATA_TAMPERED);
  expect(r.removed.sort()).toEqual([join(deep, "config"), join(deep, "hooks")]);
});

test("more directories than the search may visit fail closed, on this command and on the next", () => {
  plantGitDir(join(git, "modules", "lib"));
  const snap = gitDirsSnapshot(git, { maxVisits: 6 })!;
  expect(snap.gitDirs).toEqual([join(git, "modules", "lib")]);
  for (let i = 0; i < 8; i++) mkdirSync(join(git, "modules", `pad${i}`));
  const r = enforceNewGitDirs(snap);
  expect(r.removed).toEqual([]);
  expect(r.unsafe).toEqual([git]);
  expect(r.message).toBe(gitMetadataUnsafe(git));
  const next = gitDirsSnapshot(git, { maxVisits: 6 })!; // the next command's snapshot can't make the overflow trusted
  expect(enforceNewGitDirs(next).message).toBe(gitMetadataUnsafe(git));
});

const root = process.getuid?.() === 0;
test.skipIf(root)("a directory the search can't read fails closed, also when it was there before", () => {
  const snap = gitDirsSnapshot(git)!;
  const locked = join(git, "modules", "locked");
  plantGitDir(join(locked, "inner"));
  chmodSync(locked, 0o000);
  try {
    const r = enforceNewGitDirs(snap);
    expect(r).toEqual({ removed: [], unsafe: [locked], message: gitMetadataUnsafe(locked) });
    const next = gitDirsSnapshot(git)!;
    expect(next.known.has(locked)).toBe(false); // never part of a baseline
    expect(enforceNewGitDirs(next).message).toBe(gitMetadataUnsafe(locked));
  } finally {
    chmodSync(locked, 0o755);
  }
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

test("a link into a sandbox-writable dir is removed even when the snapshot already had it", () => {
  const writable = join(fx, "writable");
  plantGitDir(join(writable, "lib"));
  symlinkSync(writable, join(git, "modules"));
  symlinkSync(outside, join(git, "worktrees")); // into a dir the sandbox can't write: the owner's, left alone
  mkdirSync(join(git, "hooks"));
  writeFileSync(join(writable, "pre-commit"), "x");
  symlinkSync("../../../writable/pre-commit", join(git, "hooks", "pre-commit")); // relative, into the writable dir
  const snap = gitDirsSnapshot(git, { writable: [writable] })!;
  expect(snap.known.has(join(git, "modules"))).toBe(true);
  const r = enforceNewGitDirs(snap);
  expect(r.removed.sort()).toEqual([join(git, "hooks", "pre-commit"), join(git, "modules")].sort());
  expect(r.message).toBe(GIT_LINK_REMOVED);
  expect(lstatSync(join(git, "worktrees")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(writable, "lib", "hooks", "post-checkout"))).toBe(true); // never followed
  expect(readFileSync(join(writable, "pre-commit"), "utf8")).toBe("x");
});

test("a dangling link whose path would land in a writable dir is removed too", () => {
  const writable = join(fx, "writable");
  mkdirSync(writable);
  mkdirSync(join(git, "modules", "lib"), { recursive: true });
  writeFileSync(join(git, "modules", "lib", "HEAD"), "ref: x");
  symlinkSync(join(writable, "not-yet"), join(git, "modules", "lib", "config"));
  const snap = gitDirsSnapshot(git, { writable: [writable] })!;
  expect(enforceNewGitDirs(snap)).toEqual({ removed: [join(git, "modules", "lib", "config")], unsafe: [], message: GIT_LINK_REMOVED });
});

test("writableLinks lists the links into writable dirs without touching them", () => {
  const writable = join(fx, "writable");
  mkdirSync(writable);
  mkdirSync(join(git, "hooks"));
  symlinkSync(join(writable, "pre-commit"), join(git, "hooks", "pre-commit"));
  symlinkSync(outside, join(git, "worktrees"));
  const snap = gitDirsSnapshot(git, { writable: [writable] })!;
  expect(writableLinks(snap)).toEqual([join(git, "hooks", "pre-commit")]);
  expect(lstatSync(join(git, "hooks", "pre-commit")).isSymbolicLink()).toBe(true);
});

/**
 * A separate process that keeps flipping `path` between a real directory (built by `fill`, then renamed into place)
 * and a link to `victim`, as a still-running confined job could while the host cleans up.
 */
const swapper = (path: string, victim: string, scratch: string, fill: string) => {
  mkdirSync(scratch, { recursive: true });
  const code = `
    const fs = require("node:fs"); const p = require("node:path");
    const { P, V, S } = process.env; let i = 0;
    const fill = ${fill};
    for (;;) {
      const d = p.join(S, String(i++));
      try { fs.mkdirSync(d); fill(d); } catch {}
      try { fs.renameSync(d, P); } catch {}
      try { fs.renameSync(P, d + "-gone"); } catch {}
      try { fs.symlinkSync(V, P); } catch {}
      try { fs.unlinkSync(P); } catch {}
    }`;
  return Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, P: path, V: victim, S: scratch }, stdout: "ignore", stderr: "ignore" });
};

/** Every regular file under `dir` (links not followed), with its content. */
const filesUnder = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) out.set(path, readFileSync(path, "utf8"));
  }
  return out;
};

/** Runs `sweep` over and over for `ms` while `swap` races it; returns every path reported unsafe. */
const raceFor = async (ms: number, swap: ReturnType<typeof swapper>, sweep: () => string[]) => {
  const unsafe = new Set<string>();
  await Bun.sleep(50); // let the swapper start flipping
  const end = Date.now() + ms;
  try {
    while (Date.now() < end) {
      for (let i = 0; i < 200; i++) for (const path of sweep()) unsafe.add(path);
      await Bun.sleep(0);
    }
  } finally {
    swap.kill("SIGKILL");
    await swap.exited;
  }
  return unsafe;
};

test("a hooks dir flipped between a real dir and a link to a host dir while it is cleaned: the host dir's files survive", async () => {
  mkdirSync(join(git, "hooks"));
  const snap = gitDirsSnapshot(git)!;
  const fresh = join(git, "modules", "x");
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(fresh, "HEAD"), "ref: x");
  const victim = join(outside, "hooks");
  mkdirSync(victim);
  const names = ["post-checkout", "pre-commit", "pre-push", "commit-msg", "post-merge"];
  for (const name of names) writeFileSync(join(victim, name), `victim ${name}`);
  const fill = `(d) => { for (const n of ${JSON.stringify(names)}) fs.writeFileSync(p.join(d, n), "evil"); }`;
  await raceFor(1500, swapper(join(fresh, "hooks"), victim, join(fx, "scratch"), fill), () => enforceNewGitDirs(snap).unsafe);
  expect(readdirSync(victim).sort()).toEqual([...names].sort());
  for (const name of names) expect(readFileSync(join(victim, name), "utf8")).toBe(`victim ${name}`);
});

test("a git dir flipped between a real dir and a link to another repo's .git while it is cleaned: nothing of that repo is deleted", async () => {
  mkdirSync(join(git, "hooks"));
  const snap = gitDirsSnapshot(git)!;
  mkdirSync(join(git, "modules"));
  const commondirs = snapshot([git, join(git, "modules", "x")]);
  const victim = join(outside, "other", ".git");
  mkdirSync(join(victim, "hooks"), { recursive: true });
  const before = new Map<string, string>();
  for (const [rel, body] of [["HEAD", "ref: refs/heads/main\n"], ["config", "victim config"], ["commondir", "victim commondir"], ["config.worktree", "victim wt"], ["hooks/pre-commit", "victim hook"]] as const) {
    writeFileSync(join(victim, rel), body);
    before.set(rel, body);
  }
  const fill = `(d) => { fs.mkdirSync(p.join(d, "hooks")); fs.writeFileSync(p.join(d, "HEAD"), "r"); for (const n of ["config", "commondir", "config.worktree", "hooks/post-checkout"]) fs.writeFileSync(p.join(d, n), "evil"); }`;
  const unsafe = await raceFor(1500, swapper(join(git, "modules", "x"), victim, join(fx, "scratch"), fill), () => [
    ...enforceNewGitDirs(snap).unsafe,
    ...enforceCommondir(commondirs).unsafe,
  ]);
  // Every file of the other repo still exists: in place, or moved aside inside this .git and reported.
  const contents = [...filesUnder(victim).values(), ...[...filesUnder(git)].filter(([path]) => [...unsafe].some((u) => path === u || path.startsWith(`${u}/`))).map(([, body]) => body)];
  for (const body of before.values()) expect(contents).toContain(body);
});
