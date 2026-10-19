// src/exec/confinement-paths.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CACHE_PATHS, ConfinementError, confinementPaths, ENV_SCAN_DIRS, requireSingleLinks, SECRET_PATHS } from "./confinement-paths";
import { SANDBOX_CACHE_ENV } from "./env";

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

test("shell histories, other agents' and tools' tokens and the usual credential files are secrets too", () => {
  const histories = [".zsh_history", ".zsh_sessions", ".bash_history", ".bash_sessions", ".history", ".local/share/fish/fish_history", ".python_history", ".node_repl_history", ".psql_history", ".mysql_history", ".sqlite_history", ".lesshst"];
  const tokens = [".vault-token", ".terraform.d", ".config/op", ".codex", ".gemini", ".config/gcloud", ".azure", ".kube", ".docker/config.json"];
  const credentials = [".netrc", ".pgpass", ".npmrc", ".pypirc", ".cargo/credentials", ".cargo/credentials.toml", ".config/gh", "Library/Keychains"];
  for (const p of [...histories, ...tokens, ...credentials]) expect(SECRET_PATHS).toContain(p);
  expect(new Set(SECRET_PATHS).size).toBe(SECRET_PATHS.length);
});

test("the .env files of the owner's other projects are denied; the session's own project and projects inside it are left alone", () => {
  const proj = mk("proj");
  writeFileSync(join(proj, ".env"), "OWN=1");
  const inner = mk("proj", "packages", "lib");
  writeFileSync(join(inner, ".env"), "INNER=1");
  const other = mk("other");
  for (const name of [".env", ".env.local", ".envrc", "README.md", ".environment"]) writeFileSync(join(other, name), "x");
  writeFileSync(join(mk("other", "apps", "web"), ".env.production"), "x");
  writeFileSync(join(mk("other", "node_modules", "pkg"), ".env"), "x");
  writeFileSync(join(mk("other", ".git"), ".env"), "x");
  // A Python virtualenv is often called .env: a folder, nothing secret in it.
  mk("venvy", ".env", "bin");
  symlinkSync(other, join(fx, "otherlink"));
  const paths = confinementPaths({
    project: proj,
    home: join(fx, "h", ".tropos"),
    userHome: mk("h"),
    env: { TMPDIR: mk("tmp") },
    platform: "linux",
    otherProjects: [proj, inner, join(fx, "otherlink"), join(fx, "venvy"), join(fx, "missing")],
  });
  expect([...paths.otherProjectSecrets].sort()).toEqual([join(other, ".env"), join(other, ".env.local"), join(other, ".envrc"), join(other, "apps", "web", ".env.production")].sort());
});

const withOthers = (project: string, otherProjects: string[]) =>
  confinementPaths({ project, home: join(fx, "h", ".tropos"), userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "linux", otherProjects });
/** More folders than the search looks at in one project. */
const crowd = (...parts: string[]) => {
  for (let i = 0; i <= ENV_SCAN_DIRS; i++) mk(...parts, `d${i}`);
};

test("a project with more folders than the search looks at is denied whole, so none of its .env files is missed", () => {
  const big = mk("big");
  crowd("big", "libs");
  writeFileSync(join(big, ".env"), "x");
  expect(withOthers(mk("proj"), [big]).otherProjectSecrets).toEqual([big]);
});

test("each project gets its own search: one too big to search doesn't leave the next one unsearched", () => {
  const big = mk("big");
  crowd("big", "libs");
  const small = mk("small");
  writeFileSync(join(small, ".env"), "x");
  expect(withOthers(mk("proj"), [big, small]).otherProjectSecrets).toEqual([big, join(small, ".env")]);
});

test("a project too big to search that holds the session's project is denied around it, never the session's project itself", () => {
  const big = mk("big");
  crowd("big", "libs");
  writeFileSync(join(big, "README.md"), "x");
  const proj = mk("big", "apps", "app");
  mk("big", "apps", "other-app");
  const denied = withOthers(proj, [big]).otherProjectSecrets;
  expect([...denied].sort()).toEqual([join(big, "README.md"), join(big, "apps", "other-app"), join(big, "libs")].sort());
});

test("a project denied whole still has its linked .env files and its links into the home folder denied where they point", () => {
  const big = mk("big");
  crowd("big", "libs");
  const stash = mk("h", "stash");
  writeFileSync(join(stash, "app.env"), "x");
  symlinkSync(join(stash, "app.env"), join(big, ".env"));
  writeFileSync(join(mk("h", "deep"), "db.env"), "x");
  symlinkSync(join(fx, "h", "deep", "db.env"), join(mk("big", "apps", "web"), ".env.local"));
  const shared = mk("h", "shared-secrets");
  symlinkSync(shared, join(big, "shared"));
  // A link to a system folder (a toolchain, say) stays readable: no owner secrets there, and denying it breaks builds.
  symlinkSync("/usr/bin", join(big, "tools"));
  // A link to the home folder itself holds the session's project: never denied.
  symlinkSync(join(fx, "h"), join(big, "home"));
  const denied = withOthers(mk("h", "proj"), [big]).otherProjectSecrets;
  expect([...denied].sort()).toEqual([big, join(stash, "app.env"), join(fx, "h", "deep", "db.env"), shared].sort());
});

test("without other projects nothing extra is denied", () => {
  const paths = confinementPaths({ project: mk("proj"), home: join(fx, "h", ".tropos"), userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "linux" });
  expect(paths.otherProjectSecrets).toEqual([]);
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
  expect(paths.readCarveOuts).toEqual([join(fx, "home", ".tropos", "workspace"), join(fx, "home", ".tropos", "worktrees")]);
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

test("the per-sandbox cache and its tool dirs are created up front", () => {
  const paths = confinementPaths({ project: mk("proj"), home: join(fx, "home", ".tropos"), userHome: mk("home"), env: { TMPDIR: mk("tmp") }, platform: "linux" });
  expect(statSync(paths.cacheDir).isDirectory()).toBe(true);
  for (const [, tool] of SANDBOX_CACHE_ENV) expect(statSync(join(paths.cacheDir, tool)).isDirectory()).toBe(true);
});

test("a sandbox cache or tool dir that is a link or a file is refused, so a chat can't widen the next run's writes", () => {
  const opts = () => ({ project: mk("proj"), home: join(fx, "home", ".tropos"), userHome: mk("home"), env: { TMPDIR: mk("tmp") }, platform: "linux" as const });
  mk("home", ".ssh");
  // A chat can write inside the cache, so it can swap a tool dir for a link to ~/.ssh.
  mk("home", ".tropos", "sandbox-cache");
  symlinkSync(join(fx, "home", ".ssh"), join(fx, "home", ".tropos", "sandbox-cache", "npm"));
  expect(() => confinementPaths(opts())).toThrow(ConfinementError);
  rmSync(join(fx, "home", ".tropos", "sandbox-cache", "npm"));
  writeFileSync(join(fx, "home", ".tropos", "sandbox-cache", "npm"), "");
  expect(() => confinementPaths(opts())).toThrow(ConfinementError);
  // The cache root as a link.
  rmSync(join(fx, "home", ".tropos", "sandbox-cache"), { recursive: true });
  symlinkSync(join(fx, "home", ".ssh"), join(fx, "home", ".tropos", "sandbox-cache"));
  expect(() => confinementPaths(opts())).toThrow(ConfinementError);
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

test("instructionFiles are the workspace's root instruction files for a non-owner, under the real home; none otherwise", () => {
  const home = mk("h", ".tropos");
  const opts = { project: mk("proj"), home, userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "linux" as const };
  expect(confinementPaths({ ...opts, protectInstructions: true }).instructionFiles).toEqual(["TROPOS.md", "TROPOS.local.md", "CLAUDE.md", "AGENTS.override.md"].map((n) => join(realpathOr(home), "workspace", n)));
  expect(confinementPaths(opts).instructionFiles).toEqual([]);
});

test("for a non-owner, an instruction file or own file with a second hard link refuses the sandbox; the owner's runs", () => {
  const home = mk("h", ".tropos");
  const ws = join(home, "workspace");
  mkdirSync(ws, { recursive: true });
  const opts = { project: mk("proj"), home, userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "linux" as const };
  writeFileSync(join(ws, "CLAUDE.md"), "owner's");
  linkSync(join(ws, "CLAUDE.md"), join(opts.project, "claude-copy.md"));
  expect(() => confinementPaths({ ...opts, protectInstructions: true })).toThrow(ConfinementError);
  expect(() => confinementPaths({ ...opts, protectInstructions: true })).toThrow(join(realpathOr(ws), "CLAUDE.md"));
  expect(() => confinementPaths(opts)).not.toThrow();
  rmSync(join(opts.project, "claude-copy.md"));
  writeFileSync(join(ws, "USER.md"), "about the user");
  linkSync(join(ws, "USER.md"), join(opts.project, "user-copy.md"));
  expect(() => confinementPaths({ ...opts, protectInstructions: true })).toThrow(join(realpathOr(ws), "USER.md"));
  rmSync(join(opts.project, "user-copy.md"));
  expect(() => confinementPaths({ ...opts, protectInstructions: true })).not.toThrow();
});

test("for a non-owner, a hard-linked file anywhere inside the chief's folders (journal, skills, specialists) refuses the sandbox", () => {
  const home = mk("h", ".tropos");
  const opts = { project: mk("proj"), home, userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "linux" as const, protectInstructions: true };
  for (const rel of [["workspace", "memory", "2026-10-16.md"], ["workspace", "skills", "deploy", "SKILL.md"], ["agents", "reviewer", "MEMORY.md"]]) {
    const file = join(home, ...rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x");
    linkSync(file, join(opts.project, "copy"));
    expect(() => confinementPaths(opts)).toThrow("hard link");
    rmSync(join(opts.project, "copy"));
    expect(() => confinementPaths(opts)).not.toThrow();
  }
});

test("the hard-link walk is bounded and fails closed past its bound", () => {
  const dir = mk("many");
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, `f${i}`), "");
  expect(() => requireSingleLinks([dir], 10)).not.toThrow();
  expect(() => requireSingleLinks([dir], 5)).toThrow(ConfinementError);
  expect(() => requireSingleLinks([dir], 5)).toThrow("too many files");
});

test("ownFiles lists the chief's files under the real home, existing or not", () => {
  const home = mk("h", ".tropos");
  const paths = confinementPaths({ project: mk("proj"), home, userHome: mk("h"), env: { TMPDIR: mk("tmp") }, platform: "linux" });
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "BOOTSTRAP.md"]) expect(paths.ownFiles).toContain(join(home, "workspace", name));
  for (const dir of ["memory", "skills", "skills-learned"]) expect(paths.ownFiles).toContain(join(home, "workspace", dir));
  expect(paths.ownFiles).not.toContain(join(home, "workspace"));
});
