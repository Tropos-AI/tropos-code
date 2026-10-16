// src/exec/bwrap-args.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs } from "./bwrap-args";
import { confinementPaths } from "./confinement-paths";

let fx: string;
let userHome: string;
let project: string;
beforeEach(() => {
  fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-bwrap-")));
  userHome = join(fx, "home");
  project = join(fx, "proj");
  for (const d of [join(userHome, ".ssh"), join(userHome, ".tropos", "workspace"), join(project, ".git", "hooks"), join(project, ".husky"), join(project, ".tropos"), join(fx, "tmp")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(userHome, ".netrc"), "machine x");
  writeFileSync(join(project, ".git", "config"), "");
  writeFileSync(join(project, ".tropos", "settings.json"), "{}");
});
afterEach(() => rmSync(fx, { recursive: true, force: true }));

const paths = (p = project) => confinementPaths({ project: p, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") }, platform: "linux" });
const hide = (p: string) => (statSync(p).isDirectory() ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p]);
/** Index of the `--flag a b` triple (or `--flag a` pair) in args, or -1. */
const at = (args: string[], ...seq: string[]) => args.findIndex((_, i) => seq.every((s, j) => args[i + j] === s));

test("root read-only, project bound after the secrets are hidden, .git self-bound, protected paths read-only last", () => {
  const c = paths();
  const cwd = join(project, "src");
  const args = bwrapArgs(c, cwd);
  const secrets = c.deniedReads.filter((p) => existsSync(p));
  expect(secrets).toContain(join(userHome, ".ssh"));
  expect(secrets).toContain(join(userHome, ".netrc"));
  expect(args).toEqual([
    "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
    ...c.writable.filter((w) => existsSync(w)).flatMap((w) => ["--bind", w, w]),
    ...secrets.flatMap(hide),
    "--ro-bind", join(userHome, ".tropos", "workspace"), join(userHome, ".tropos", "workspace"),
    "--bind", project, project,
    "--bind", join(project, ".git"), join(project, ".git"),
    "--ro-bind", join(project, ".git", "hooks"), join(project, ".git", "hooks"),
    "--ro-bind", join(project, ".git", "config"), join(project, ".git", "config"),
    "--ro-bind", join(project, ".husky"), join(project, ".husky"),
    "--ro-bind", join(project, ".tropos"), join(project, ".tropos"),
    "--chdir", cwd,
  ]);
  expect(args).toContain(join(fx, "tmp"));
  expect(at(args, "--tmpfs", join(userHome, ".ssh"))).toBeGreaterThan(0);
  expect(at(args, "--ro-bind", "/dev/null", join(userHome, ".netrc"))).toBeGreaterThan(0);
});

test("Tropos's workspace as the project: no read-only carve-out, the project bind reopens it inside the hidden home", () => {
  const ws = join(userHome, ".tropos", "workspace");
  const args = bwrapArgs(paths(ws), ws);
  expect(at(args, "--ro-bind", ws, ws)).toBe(-1);
  expect(at(args, "--tmpfs", join(userHome, ".tropos"))).toBeLessThan(at(args, "--bind", ws, ws));
  expect(at(args, "--bind", join(ws, ".git"), join(ws, ".git"))).toBe(-1); // no .git there
});

test("a project that holds the user's home hides the secrets again after binding it, and keeps the workspace read-only", () => {
  const args = bwrapArgs(paths(userHome), userHome);
  const projectBind = at(args, "--bind", userHome, userHome);
  expect(projectBind).toBeGreaterThan(0);
  expect(at(args.slice(projectBind), "--tmpfs", join(userHome, ".ssh"))).toBeGreaterThan(0);
  expect(at(args.slice(projectBind), "--ro-bind", "/dev/null", join(userHome, ".netrc"))).toBeGreaterThan(0);
  const tropos = at(args.slice(projectBind), "--tmpfs", join(userHome, ".tropos"));
  const ws = join(userHome, ".tropos", "workspace");
  expect(tropos).toBeGreaterThan(0);
  expect(at(args.slice(projectBind + tropos), "--ro-bind", ws, ws)).toBeGreaterThan(0);
  expect(args.at(-2)).toBe("--chdir");
});
