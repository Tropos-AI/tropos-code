// src/exec/confinement-paths.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CACHE_PATHS, confinementPaths, SECRET_PATHS } from "./confinement-paths";

let fx: string;
beforeEach(() => {
  fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-conf-")));
});
afterEach(() => rmSync(fx, { recursive: true, force: true }));

const mk = (...parts: string[]) => {
  const p = join(fx, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

test("the secrets list holds every path the spec names", () => {
  for (const p of [".ssh", ".aws", ".gnupg", ".config/gh", ".docker/config.json", ".netrc", "Library/Keychains"]) expect(SECRET_PATHS).toContain(p);
  for (const p of [".claude", ".kube", ".password-store", "Library/Application Support/Google/Chrome", "Library/Safari", ".mozilla", "/Library/Keychains"]) expect(SECRET_PATHS).toContain(p);
  for (const p of [".npm", ".bun/install/cache", ".cache/pip", "Library/Caches/Homebrew", "go/pkg/mod"]) expect(CACHE_PATHS).toContain(p);
});

test("paths are real paths; Tropos's home is denied and its workspace carved out; caches and temp are writable", () => {
  mk("home", ".ssh");
  mk("home", ".tropos", "workspace");
  mk("home", ".npm");
  mk("proj", ".git", "hooks");
  mk("tmp");
  // Everything is handed over through links, as a user's config might be.
  symlinkSync(join(fx, "home"), join(fx, "homelink"));
  symlinkSync(join(fx, "proj"), join(fx, "projlink"));
  symlinkSync(fx, join(fx, "fxlink"));
  const paths = confinementPaths({
    project: join(fx, "projlink"),
    home: join(fx, "homelink", ".tropos"),
    userHome: join(fx, "homelink"),
    env: { TMPDIR: join(fx, "fxlink", "tmp") },
    platform: "linux",
  });
  expect(paths.project).toBe(join(fx, "proj"));
  expect(paths.platform).toBe("linux");
  expect(paths.deniedReads).toContain(join(fx, "home", ".ssh"));
  expect(paths.deniedReads).toContain(join(fx, "home", ".tropos"));
  expect(paths.deniedReads).toContain(join(fx, "home", ".aws")); // missing: joined onto the real home
  expect(paths.deniedReads).toContain(join(fx, "home", ".config", "gh"));
  expect(paths.deniedReads).toContain(realpathOr("/Library/Keychains"));
  expect(paths.deniedReads).toHaveLength(SECRET_PATHS.length + 1);
  expect(paths.readCarveOut).toBe(join(fx, "home", ".tropos", "workspace"));
  expect(paths.cacheDir).toBe(join(fx, "home", ".tropos", "sandbox-cache"));
  expect(paths.writable).toContain(join(fx, "tmp"));
  expect(paths.writable).toContain(realpathOr("/tmp")); // root's, so resolved even when it is a link (macOS)
  // The owner's host caches are NOT writable; only the per-sandbox cache is (handled via cacheDir, not in writable).
  expect(paths.writable).not.toContain(join(fx, "home", ".npm"));
  expect(paths.writable).not.toContain(join(fx, "home", ".cache", "pnpm"));
  expect(paths.writable).toHaveLength(new Set(paths.writable).size);
  for (const p of [...paths.writable, ...paths.deniedReads, ...paths.gitDirs, ...paths.husky, paths.cacheDir]) expect(/homelink|projlink|fxlink/.test(p)).toBe(false);
});

test("darwin adds /private/tmp, not /tmp", () => {
  const paths = confinementPaths({ project: mk("proj"), home: join(fx, "h", ".tropos"), userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "darwin" });
  expect(paths.writable).toContain("/private/tmp");
  expect(paths.writable).not.toContain("/tmp");
});

const darwinTemp = /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(realpathOr(tmpdir()));
test.skipIf(!darwinTemp)("a darwin per-user temp dir brings its sibling C (the per-user cache dir)", () => {
  const paths = confinementPaths({ project: mk("proj"), home: join(fx, "h", ".tropos"), userHome: mk("h"), env: {}, platform: "darwin" });
  const t = realpathOr(tmpdir());
  expect(paths.writable).toContain(t);
  expect(paths.writable).toContain(join(dirname(t), "C"));
});

test("a writable temp path whose last part is a link is left out, so one run can't widen the next run's writes", () => {
  mk("home", ".ssh");
  mk("tmp");
  // A chat can write inside its temp dir, so it can plant a link where TMPDIR points; following it would widen writes.
  symlinkSync(join(fx, "home", ".ssh"), join(fx, "tmplink"));
  const paths = confinementPaths({ project: mk("proj"), home: join(fx, "home", ".tropos"), userHome: join(fx, "home"), env: { TMPDIR: join(fx, "tmplink") }, platform: "linux" });
  for (const p of [join(fx, "home", ".ssh"), join(fx, "tmplink")]) expect(paths.writable).not.toContain(p);
});

test("the per-sandbox cache sits under Tropos's home and is not among the host-cache writables", () => {
  const paths = confinementPaths({ project: mk("proj"), home: join(fx, "home", ".tropos"), userHome: mk("home"), env: { TMPDIR: mk("tmp") }, platform: "linux" });
  expect(paths.cacheDir).toBe(join(fx, "home", ".tropos", "sandbox-cache"));
  // The owner's host caches appear nowhere in writable.
  for (const cache of CACHE_PATHS) expect(paths.writable).not.toContain(join(fx, "home", cache));
});

test("a .git symlink to a folder inside the project protects that folder too", () => {
  const proj = mk("proj");
  mk("proj", "realgit", "hooks");
  symlinkSync(join(proj, "realgit"), join(proj, ".git"));
  mk("proj", "realhusky");
  symlinkSync("realhusky", join(proj, ".husky"));
  const paths = confinementPaths({ project: proj, home: join(fx, "h", ".tropos"), userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "darwin" });
  expect(paths.gitDirs).toEqual([join(proj, ".git"), join(proj, "realgit")]);
  expect(paths.husky).toEqual([join(proj, ".husky"), join(proj, "realhusky")]);
});

test("a .git link is followed only while it stays in the project, lexically or for real", () => {
  const proj = mk("proj");
  const outside = mk("outside");
  // .git -> hop (inside, lexically) -> outside (for real): the hop is protected, the outside folder isn't ours.
  symlinkSync(outside, join(proj, "hop"));
  symlinkSync("hop", join(proj, ".git"));
  // .husky -> outside: nothing beyond the link itself.
  symlinkSync(outside, join(proj, ".husky"));
  const paths = confinementPaths({ project: proj, home: join(fx, "h", ".tropos"), userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "darwin" });
  expect(paths.gitDirs).toEqual([join(proj, ".git"), join(proj, "hop")]);
  expect(paths.husky).toEqual([join(proj, ".husky")]);
});

test("a project without .git or .husky still protects both names, so neither can be created", () => {
  const proj = mk("proj");
  writeFileSync(join(proj, "README"), "");
  const paths = confinementPaths({ project: proj, home: join(fx, "h", ".tropos"), userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "darwin" });
  expect(paths.gitDirs).toEqual([join(proj, ".git")]);
  expect(paths.husky).toEqual([join(proj, ".husky")]);
});

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
