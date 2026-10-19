// src/exec/bwrap-args.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs, hostServiceMasks, hostServicePaths } from "./bwrap-args";
import { ConfinementError, confinementPaths } from "./confinement-paths";

let fx: string;
let userHome: string;
let project: string;
beforeEach(() => {
  fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-bwrap-")));
  userHome = join(fx, "home");
  project = join(fx, "proj");
  for (const d of [join(userHome, ".ssh"), join(userHome, ".tropos", "workspace"), join(project, ".git", "hooks"), join(project, ".husky"), join(project, ".tropos"), join(fx, "tmp")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(userHome, ".netrc"), "machine x");
  writeFileSync(join(project, ".git", "config"), "[core]");
  writeFileSync(join(project, ".tropos", "settings.json"), "{}");
});
afterEach(() => rmSync(fx, { recursive: true, force: true }));

const paths = (p = project) => confinementPaths({ project: p, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") }, platform: "linux" });
/** Index of the given run of arguments in args, or -1. */
const at = (args: string[], ...seq: string[]) => args.findIndex((_, i) => seq.every((s, j) => args[i + j] === s));
const ro = (p: string) => ["--ro-bind", p, p];
const emptyDir = (p: string) => ["--tmpfs", p, "--remount-ro", p];
const nullFile = (p: string) => ["--ro-bind", "/dev/null", p];

test("the namespace is fresh with only inet networking and the root read-only", () => {
  const args = bwrapArgs(paths(), join(project, "src"));
  expect(args.slice(0, 11)).toEqual(["--unshare-all", "--share-net", "--new-session", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]);
  expect(hostServicePaths(1234)).toEqual(["/run/user/1234", "/run/docker.sock", "/var/run/docker.sock", "/run/dbus", "/var/run/dbus"]);
});

let svc: string;
beforeAll(() => {
  svc = realpathSync(mkdtempSync(join(tmpdir(), "tropos-svc-")));
});
afterAll(() => rmSync(svc, { recursive: true, force: true }));

test("host-service masks: a directory gets a tmpfs", () => {
  mkdirSync(join(svc, "user-1000"), { recursive: true });
  expect(hostServiceMasks([join(svc, "user-1000")])).toEqual(["--tmpfs", join(svc, "user-1000")]);
});

test("host-service masks: a socket gets /dev/null bound over it", () => {
  const sock = join(svc, "docker.sock");
  const server = Bun.listen({ unix: sock, socket: { data() {} } });
  try {
    expect(hostServiceMasks([sock])).toEqual(["--ro-bind", "/dev/null", sock]);
  } finally {
    server.stop(true);
  }
});

test("host-service masks: a plain file gets /dev/null; a missing path is skipped", () => {
  writeFileSync(join(svc, "file"), "");
  expect(hostServiceMasks([join(svc, "file"), join(svc, "missing")])).toEqual(["--ro-bind", "/dev/null", join(svc, "file")]);
});

test("the project is bound after the secrets are hidden and the cache is rebound; protections come last", () => {
  const c = paths();
  const cwd = join(project, "src");
  const args = bwrapArgs(c, cwd);
  // Secrets hidden: a dir as an empty read-only tmpfs, a file via /dev/null.
  const ssh = at(args, ...emptyDir(join(userHome, ".ssh")));
  expect(ssh).toBeGreaterThan(0);
  expect(at(args, ...nullFile(join(userHome, ".netrc")))).toBeGreaterThan(0);
  // The cache lives in the hidden ~/.tropos, so it is rebound writable after the secret is hidden.
  const cache = at(args, "--bind", c.cacheDir, c.cacheDir);
  const carve = at(args, ...ro(join(userHome, ".tropos", "workspace")));
  expect(at(args, ...ro(join(userHome, ".tropos", "worktrees")))).toBe(-1); // absent: nothing to carve out
  const projectBind = at(args, "--bind", project, project);
  expect(at(args, ...emptyDir(join(userHome, ".tropos")))).toBeLessThan(cache);
  expect(ssh).toBeLessThan(projectBind);
  expect(cache).toBeLessThan(projectBind);
  expect(carve).toBeLessThan(projectBind);
  const gitBind = at(args, "--bind", join(project, ".git"), join(project, ".git"));
  expect(gitBind).toBeGreaterThan(projectBind);
  expect(args.slice(-2)).toEqual(["--chdir", cwd]);
});

test("existing protected paths are bound read-only onto themselves, so they stay readable", () => {
  const args = bwrapArgs(paths(), project);
  const gitBind = at(args, "--bind", join(project, ".git"), join(project, ".git"));
  for (const p of [join(project, ".git", "hooks"), join(project, ".git", "config"), join(project, ".husky"), join(project, ".tropos")]) {
    expect(at(args, ...ro(p))).toBeGreaterThan(gitBind);
  }
  // Never hidden: the chat's own git still reads the repo config.
  expect(at(args, ...nullFile(join(project, ".git", "config")))).toBe(-1);
});

test("missing protected paths get read-only placeholders, so they can't be created", () => {
  rmSync(join(project, ".git", "hooks"), { recursive: true });
  rmSync(join(project, ".husky"), { recursive: true });
  rmSync(join(project, ".tropos"), { recursive: true });
  const args = bwrapArgs(paths(), project);
  expect(at(args, ...emptyDir(join(project, ".git", "hooks")))).toBeGreaterThan(0);
  expect(at(args, ...nullFile(join(project, ".git", "config.worktree")))).toBeGreaterThan(0);
  expect(at(args, ...emptyDir(join(project, ".husky")))).toBeGreaterThan(0);
  expect(at(args, ...emptyDir(join(project, ".tropos")))).toBeGreaterThan(0);
});

test("without a .git, an empty read-only .git placeholder stops `git init` (as the macOS profile does)", () => {
  rmSync(join(project, ".git"), { recursive: true });
  const args = bwrapArgs(paths(), project);
  expect(at(args, "--bind", join(project, ".git"), join(project, ".git"))).toBe(-1);
  expect(at(args, ...emptyDir(join(project, ".git")))).toBeGreaterThan(at(args, "--bind", project, project));
  expect(args.filter((a) => a.startsWith(`${join(project, ".git")}/`))).toEqual([]);
});

test("commondir is bound read-only only when it already exists (an empty placeholder would break git)", () => {
  expect(bwrapArgs(paths(), project).includes(join(project, ".git", "commondir"))).toBe(false);
  writeFileSync(join(project, ".git", "commondir"), ".");
  expect(at(bwrapArgs(paths(), project), ...ro(join(project, ".git", "commondir")))).toBeGreaterThan(0);
});

test("nested git dirs (submodules and linked worktrees) get their own protections", () => {
  mkdirSync(join(project, ".git", "modules", "lib"), { recursive: true });
  writeFileSync(join(project, ".git", "modules", "lib", "HEAD"), "ref: x");
  mkdirSync(join(project, ".git", "worktrees", "wt"), { recursive: true });
  writeFileSync(join(project, ".git", "worktrees", "wt", "HEAD"), "ref: x");
  writeFileSync(join(project, ".git", "worktrees", "wt", "commondir"), "../..");
  mkdirSync(join(project, ".git", "modules", "libs", "foo"), { recursive: true });
  writeFileSync(join(project, ".git", "modules", "libs", "foo", "HEAD"), "ref: x");
  const args = bwrapArgs(paths(), project);
  expect(at(args, ...emptyDir(join(project, ".git", "modules", "lib", "hooks")))).toBeGreaterThan(0);
  expect(at(args, ...emptyDir(join(project, ".git", "modules", "libs", "foo", "hooks")))).toBeGreaterThan(0); // a submodule named libs/foo
  expect(at(args, ...nullFile(join(project, ".git", "worktrees", "wt", "config")))).toBeGreaterThan(0);
  expect(at(args, ...ro(join(project, ".git", "worktrees", "wt", "commondir")))).toBeGreaterThan(0);
});

test("a symlinked or file .git is refused rather than confined weaker", () => {
  rmSync(join(project, ".git"), { recursive: true });
  symlinkSync(join(fx, "elsewhere"), join(project, ".git"));
  expect(() => bwrapArgs(paths(), project)).toThrow(ConfinementError);
});

test("a gitfile in an ordinary project is refused", () => {
  rmSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git"), "gitdir: .hidden-git\n");
  expect(() => paths()).toThrow(ConfinementError);
});

test("a Tropos worktree's referenced git dirs keep hooks and config read-only", () => {
  const repo = join(fx, "repo", ".git");
  const admin = join(repo, "worktrees", "t1");
  mkdirSync(join(repo, "hooks"), { recursive: true });
  mkdirSync(join(admin, "hooks"), { recursive: true });
  writeFileSync(join(repo, "config"), "[core]");
  writeFileSync(join(admin, "commondir"), "../..\n");
  const wt = join(userHome, ".tropos", "worktrees", "app", "t1");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${admin}\n`);
  const c = paths(wt);
  expect(c.linkedGitDirs).toEqual([admin, repo]);
  const args = bwrapArgs(c, wt);
  const bind = at(args, "--bind", wt, wt);
  for (const p of [join(repo, "hooks"), join(repo, "config"), join(admin, "hooks"), join(admin, "commondir")]) expect(at(args, ...ro(p))).toBeGreaterThan(bind);
});

test("a linked worktree's .git file is kept read-only in place, and the worktrees folder is carved out for reading", () => {
  const wt = join(userHome, ".tropos", "worktrees", "app", "t1");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/t1\n");
  const args = bwrapArgs(paths(wt), wt);
  const carve = at(args, ...ro(join(userHome, ".tropos", "worktrees")));
  const bind = at(args, "--bind", wt, wt);
  expect(carve).toBeGreaterThan(0);
  expect(carve).toBeLessThan(bind);
  expect(at(args, ...ro(join(wt, ".git")))).toBeGreaterThan(bind);
  expect(at(args, ...emptyDir(join(wt, ".git")))).toBe(-1);
});

test("a symlinked or file .tropos is refused", () => {
  rmSync(join(project, ".tropos"), { recursive: true });
  mkdirSync(join(fx, "settings-elsewhere"));
  symlinkSync(join(fx, "settings-elsewhere"), join(project, ".tropos"));
  expect(() => bwrapArgs(paths(), project)).toThrow(ConfinementError);
  rmSync(join(project, ".tropos"));
  writeFileSync(join(project, ".tropos"), "");
  expect(() => bwrapArgs(paths(), project)).toThrow(ConfinementError);
});

test("a symlinked or file .husky is refused", () => {
  rmSync(join(project, ".husky"), { recursive: true });
  mkdirSync(join(project, "realhusky"));
  symlinkSync(join(project, "realhusky"), join(project, ".husky"));
  expect(() => bwrapArgs(paths(), project)).toThrow(ConfinementError);
  rmSync(join(project, ".husky"));
  writeFileSync(join(project, ".husky"), "");
  expect(() => bwrapArgs(paths(), project)).toThrow(ConfinementError);
});

test("a project that holds the user's home hides the secrets again after binding it, and keeps the workspace readable", () => {
  const c = paths(userHome);
  const args = bwrapArgs(c, userHome);
  const projectBind = at(args, "--bind", userHome, userHome);
  expect(projectBind).toBeGreaterThan(0);
  const after = args.slice(projectBind);
  expect(at(after, ...emptyDir(join(userHome, ".ssh")))).toBeGreaterThan(0);
  expect(at(after, ...nullFile(join(userHome, ".netrc")))).toBeGreaterThan(0);
  const tropos = at(after, ...emptyDir(join(userHome, ".tropos")));
  expect(tropos).toBeGreaterThan(0);
  expect(at(after.slice(tropos), ...ro(join(userHome, ".tropos", "workspace")))).toBeGreaterThan(0);
  expect(at(after.slice(tropos), "--bind", c.cacheDir, c.cacheDir)).toBeGreaterThan(0);
});

test("the chief's own files are masked after the project bind and the workspace carve-out", () => {
  const ws = join(userHome, ".tropos", "workspace");
  mkdirSync(join(ws, "memory"), { recursive: true });
  writeFileSync(join(ws, "USER.md"), "u");
  // Seen from another project: after the carve-out bind.
  let c = paths();
  let args = bwrapArgs(c, project);
  const carve = at(args, ...ro(ws));
  expect(carve).toBeGreaterThan(0);
  expect(at(args, ...nullFile(join(ws, "USER.md")))).toBeGreaterThan(carve);
  expect(at(args, ...emptyDir(join(ws, "memory")))).toBeGreaterThan(carve);
  expect(at(args, ...nullFile(join(ws, "AGENTS.md")))).toBe(-1); // missing, and the workspace is read-only here: nothing can be created
  // The workspace as the project: after the project bind.
  c = paths(ws);
  args = bwrapArgs(c, ws);
  const projectBind = at(args, "--bind", ws, ws);
  expect(at(args, ...nullFile(join(ws, "USER.md")))).toBeGreaterThan(projectBind);
  expect(at(args, ...emptyDir(join(ws, "memory")))).toBeGreaterThan(projectBind);
});

test("missing own files inside a writable workspace get read-only placeholders, so a command can't create them", () => {
  const ws = join(userHome, ".tropos", "workspace");
  mkdirSync(ws, { recursive: true });
  const c = paths(ws);
  const args = bwrapArgs(c, ws);
  const projectBind = at(args, "--bind", ws, ws);
  for (const name of ["USER.md", "SOUL.md", "AGENTS.md", "MEMORY.md", "BOOTSTRAP.md", "IDENTITY.md"]) expect(at(args, ...nullFile(join(ws, name)))).toBeGreaterThan(projectBind);
  for (const name of ["memory", "skills", "skills-learned"]) expect(at(args, ...emptyDir(join(ws, name)))).toBeGreaterThan(projectBind);
});

test("for a non-owner, the workspace's instruction files are read-only, with placeholders where missing; an owner's are not", () => {
  const ws = join(userHome, ".tropos", "workspace");
  writeFileSync(join(ws, "CLAUDE.md"), "owner's");
  const guarded = confinementPaths({ project: ws, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") }, platform: "linux", protectInstructions: true });
  const args = bwrapArgs(guarded, ws);
  const projectBind = at(args, "--bind", ws, ws);
  expect(at(args, ...ro(join(ws, "CLAUDE.md")))).toBeGreaterThan(projectBind);
  for (const name of ["TROPOS.md", "TROPOS.local.md", "AGENTS.override.md"]) expect(at(args, ...nullFile(join(ws, name)))).toBeGreaterThan(projectBind);
  const owner = bwrapArgs(paths(ws), ws);
  expect(at(owner, ...nullFile(join(ws, "TROPOS.md")))).toBe(-1);
  expect(at(owner, ...ro(join(ws, "CLAUDE.md")))).toBe(-1);
});

test("an instruction file that is a link refuses a non-owner's sandbox", () => {
  const ws = join(userHome, ".tropos", "workspace");
  symlinkSync(join(fx, "elsewhere.md"), join(ws, "TROPOS.md"));
  const guarded = confinementPaths({ project: ws, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") }, platform: "linux", protectInstructions: true });
  expect(() => bwrapArgs(guarded, ws)).toThrow(join(ws, "TROPOS.md"));
});

test("an own file that is a link, even a dangling one, refuses the sandbox", () => {
  const ws = join(userHome, ".tropos", "workspace");
  symlinkSync(join(fx, "nowhere"), join(ws, "USER.md"));
  expect(() => bwrapArgs(paths(ws), ws)).toThrow(ConfinementError);
  expect(() => bwrapArgs(paths(ws), ws)).toThrow(join(ws, "USER.md"));
});

test("a worktree git dir inside a writable path is refused, not confined weakly", () => {
  const p = paths();
  for (const dir of [join(project, "inner", ".git"), join(fx, "tmp", "r", ".git")]) {
    expect(() => bwrapArgs({ ...p, linkedGitDirs: [dir] }, project)).toThrow(ConfinementError);
  }
  expect(() => bwrapArgs({ ...p, linkedGitDirs: [join(fx, "elsewhere", ".git")] }, project)).not.toThrow();
});
