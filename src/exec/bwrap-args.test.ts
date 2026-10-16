// src/exec/bwrap-args.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs } from "./bwrap-args";
import { ConfinementError, confinementPaths } from "./confinement-paths";

let fx: string;
let userHome: string;
let project: string;
beforeEach(() => {
  fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-bwrap-")));
  userHome = join(fx, "home");
  project = join(fx, "proj");
  for (const d of [join(userHome, ".ssh"), join(userHome, ".tropos", "workspace"), join(userHome, ".tropos", "sandbox-cache"), join(project, ".git", "hooks"), join(project, ".husky"), join(project, ".tropos"), join(fx, "tmp")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(userHome, ".netrc"), "machine x");
  writeFileSync(join(project, ".git", "config"), "");
  writeFileSync(join(project, ".tropos", "settings.json"), "{}");
});
afterEach(() => rmSync(fx, { recursive: true, force: true }));

const paths = (p = project) => confinementPaths({ project: p, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") }, platform: "linux" });
/** Index of the `--flag a b` triple (or `--flag a` pair) in args, or -1. */
const at = (args: string[], ...seq: string[]) => args.findIndex((_, i) => seq.every((s, j) => args[i + j] === s));

test("the namespace is fresh with only inet networking, the host sockets masked, the root read-only", () => {
  const args = bwrapArgs(paths(), join(project, "src"));
  expect(args.slice(0, 11)).toEqual(["--unshare-all", "--share-net", "--new-session", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]);
  const uid = process.getuid?.() ?? 1000;
  expect(at(args, "--tmpfs", `/run/user/${uid}`)).toBeGreaterThan(0);
  for (const sock of ["/run/docker.sock", "/var/run/docker.sock", "/run/dbus", "/var/run/dbus"]) expect(at(args, "--tmpfs", sock)).toBeGreaterThan(0);
});

test("the project is bound after the secrets are hidden and the cache is rebound; protections come last", () => {
  const c = paths();
  const cwd = join(project, "src");
  const args = bwrapArgs(c, cwd);
  // Secrets hidden: a dir as an empty read-only tmpfs, a file via /dev/null.
  expect(at(args, "--tmpfs", join(userHome, ".ssh"), "--remount-ro", join(userHome, ".ssh"))).toBeGreaterThan(0);
  expect(at(args, "--ro-bind", "/dev/null", join(userHome, ".netrc"))).toBeGreaterThan(0);
  // The cache lives in the hidden ~/.tropos, so it is rebound writable after the secret is hidden.
  const ssh = at(args, "--tmpfs", join(userHome, ".ssh"));
  const cache = at(args, "--bind", c.cacheDir, c.cacheDir);
  const carve = at(args, "--ro-bind", join(userHome, ".tropos", "workspace"), join(userHome, ".tropos", "workspace"));
  const projectBind = at(args, "--bind", project, project);
  expect(ssh).toBeLessThan(cache);
  expect(cache).toBeLessThan(projectBind);
  expect(carve).toBeLessThan(projectBind);
  // .git bound (a mount point, unrenameable), then hooks/config/config.worktree read-only.
  const gitBind = at(args, "--bind", join(project, ".git"), join(project, ".git"));
  expect(gitBind).toBeGreaterThan(projectBind);
  expect(at(args, "--tmpfs", join(project, ".git", "hooks"), "--remount-ro", join(project, ".git", "hooks"))).toBeGreaterThan(gitBind);
  expect(at(args, "--ro-bind", "/dev/null", join(project, ".git", "config"))).toBeGreaterThan(gitBind);
  expect(at(args, "--ro-bind", "/dev/null", join(project, ".git", "config.worktree"))).toBeGreaterThan(gitBind);
  expect(at(args, "--tmpfs", join(project, ".husky"), "--remount-ro", join(project, ".husky"))).toBeGreaterThan(gitBind);
  // .tropos and its settings masked read-only, whether or not they exist.
  expect(at(args, "--tmpfs", join(project, ".tropos"), "--remount-ro", join(project, ".tropos"))).toBeGreaterThan(projectBind);
  expect(at(args, "--ro-bind", "/dev/null", join(project, ".tropos", "settings.json"))).toBeGreaterThan(projectBind);
  expect(at(args, "--ro-bind", "/dev/null", join(project, ".tropos", "settings.local.json"))).toBeGreaterThan(projectBind);
  expect(args.slice(-2)).toEqual(["--chdir", cwd]);
});

test("protected paths that don't exist yet are still masked, so they can't be created", () => {
  rmSync(join(project, ".git"), { recursive: true });
  rmSync(join(project, ".husky"), { recursive: true });
  rmSync(join(project, ".tropos"), { recursive: true });
  const args = bwrapArgs(paths(), project);
  // No .git dir, so no git-internal masks and no .git self-bind; .tropos is still masked.
  expect(at(args, "--bind", join(project, ".git"), join(project, ".git"))).toBe(-1);
  expect(at(args, "--tmpfs", join(project, ".tropos"), "--remount-ro", join(project, ".tropos"))).toBeGreaterThan(0);
  expect(at(args, "--ro-bind", "/dev/null", join(project, ".tropos", "settings.json"))).toBeGreaterThan(0);
});

test("commondir is masked only when it already exists (an empty placeholder would break git)", () => {
  const without = bwrapArgs(paths(), project);
  expect(at(without, "--ro-bind", "/dev/null", join(project, ".git", "commondir"))).toBe(-1);
  writeFileSync(join(project, ".git", "commondir"), ".");
  const withIt = bwrapArgs(paths(), project);
  expect(at(withIt, "--ro-bind", "/dev/null", join(project, ".git", "commondir"))).toBeGreaterThan(0);
});

test("nested git dirs (submodules and linked worktrees) get their own protections", () => {
  mkdirSync(join(project, ".git", "modules", "lib"), { recursive: true });
  writeFileSync(join(project, ".git", "modules", "lib", "HEAD"), "ref: x");
  mkdirSync(join(project, ".git", "worktrees", "wt"), { recursive: true });
  writeFileSync(join(project, ".git", "worktrees", "wt", "HEAD"), "ref: x");
  writeFileSync(join(project, ".git", "worktrees", "wt", "commondir"), "../..");
  const args = bwrapArgs(paths(), project);
  expect(at(args, "--tmpfs", join(project, ".git", "modules", "lib", "hooks"), "--remount-ro", join(project, ".git", "modules", "lib", "hooks"))).toBeGreaterThan(0);
  expect(at(args, "--ro-bind", "/dev/null", join(project, ".git", "worktrees", "wt", "config"))).toBeGreaterThan(0);
  expect(at(args, "--ro-bind", "/dev/null", join(project, ".git", "worktrees", "wt", "commondir"))).toBeGreaterThan(0);
});

test("a symlinked or file .git or .tropos is refused rather than confined weaker", () => {
  rmSync(join(project, ".git"), { recursive: true });
  symlinkSync(join(fx, "elsewhere"), join(project, ".git"));
  expect(() => bwrapArgs(paths(), project)).toThrow(ConfinementError);

  rmSync(join(project, ".git"));
  writeFileSync(join(project, ".git"), "gitdir: /elsewhere"); // a worktree gitfile
  expect(() => bwrapArgs(paths(), project)).toThrow(ConfinementError);
});

test("a project that holds the user's home hides the secrets again after binding it, and keeps the workspace readable", () => {
  const args = bwrapArgs(paths(userHome), userHome);
  const projectBind = at(args, "--bind", userHome, userHome);
  expect(projectBind).toBeGreaterThan(0);
  expect(at(args.slice(projectBind), "--tmpfs", join(userHome, ".ssh"))).toBeGreaterThan(0);
  expect(at(args.slice(projectBind), "--ro-bind", "/dev/null", join(userHome, ".netrc"))).toBeGreaterThan(0);
  const ws = join(userHome, ".tropos", "workspace");
  expect(at(args.slice(projectBind), "--tmpfs", join(userHome, ".tropos"))).toBeGreaterThan(0);
  expect(at(args.slice(projectBind), "--ro-bind", ws, ws)).toBeGreaterThan(0);
  // The cache inside the re-hidden ~/.tropos is rebound writable.
  const c = paths(userHome);
  expect(at(args.slice(projectBind), "--bind", c.cacheDir, c.cacheDir)).toBeGreaterThan(0);
});

test("the hide helper marks a directory as an empty read-only tmpfs and a file via /dev/null", () => {
  const args = bwrapArgs(paths(), project);
  expect(statSync(join(userHome, ".ssh")).isDirectory()).toBe(true);
  expect(at(args, "--tmpfs", join(userHome, ".ssh"), "--remount-ro", join(userHome, ".ssh"))).toBeGreaterThan(0);
  expect(statSync(join(userHome, ".netrc")).isFile()).toBe(true);
  expect(at(args, "--ro-bind", "/dev/null", join(userHome, ".netrc"))).toBeGreaterThan(0);
});
