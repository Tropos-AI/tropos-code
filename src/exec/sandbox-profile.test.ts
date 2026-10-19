// src/exec/sandbox-profile.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfinementError, type ConfinementPaths, confinementPaths } from "./confinement-paths";
import { sandboxProfile } from "./sandbox-profile";

const base: ConfinementPaths = {
  project: "/w/app",
  writable: ["/private/var/folders/x/y/T", "/private/tmp"],
  cacheDir: "/u/.tropos/sandbox-cache",
  gitDirs: ["/w/app/.git", "/w/app/realgit"],
  husky: ["/w/app/.husky"],
  worktreesRoot: "/u/.tropos/worktrees",
  linkedGitDirs: [],
  deniedReads: ["/u/.ssh", "/u/.tropos", "/Library/Keychains"],
  readCarveOuts: ["/u/.tropos/workspace", "/u/.tropos/worktrees"],
  ownFiles: ["/u/.tropos/workspace/USER.md", "/u/.tropos/workspace/memory"],
  instructionFiles: [],
  otherProjects: [],
  otherProjectSecrets: [],
  platform: "darwin",
};

test("other projects' .env files (or whole folders) are read-denied after the carve-outs, and before the chief's own files", () => {
  const { profile, params } = sandboxProfile({ ...base, otherProjectSecrets: ["/u/.tropos/workspace/.env", "/w/other"] });
  const carve = profile.indexOf('(allow file-read* (subpath (param "C0"))');
  const deny = profile.indexOf('(deny file-read* (subpath (param "E0")) (subpath (param "E1"))');
  expect(carve).toBeGreaterThan(0);
  expect(deny).toBeGreaterThan(carve);
  expect(deny).toBeLessThan(profile.indexOf("(deny file-read* file-write* (regex"));
  expect(params).toContainEqual(["E0", "/u/.tropos/workspace/.env"]);
  expect(params).toContainEqual(["E1", "/w/other"]);
  expect(ruleWith(profile, '(deny file-read* (subpath (param "E0"))')).toContain('(regex #"^/[Ww]/[Oo][Tt][Hh][Ee][Rr](/.*)?$")');
});

test("one pattern per other project denies its .env files at any depth and reopens its templates", () => {
  const { profile, params } = sandboxProfile({ ...base, otherProjects: ["/w/other"] });
  const deny = ruleWith(profile, '(deny file-read* (regex #"^/[Ww]/[Oo][Tt][Hh][Ee][Rr]/');
  expect(deny).toBe('(deny file-read* (regex #"^/[Ww]/[Oo][Tt][Hh][Ee][Rr]/(.*/)?\\.[Ee][Nn][Vv]([Rr][Cc]|\\.[^/]+)?$"))');
  const allow = profile.indexOf('(allow file-read* (regex #"^/[Ww]/[Oo][Tt][Hh][Ee][Rr]/(.*/)?\\.[Ee][Nn][Vv]\\.([Ee][Xx][Aa][Mm][Pp][Ll][Ee]|[Ss][Aa][Mm][Pp][Ll][Ee]|[Tt][Ee][Mm][Pp][Ll][Aa][Tt][Ee])$"))');
  expect(allow).toBeGreaterThan(profile.indexOf(deny));
  expect(profile.indexOf(deny)).toBeGreaterThan(profile.indexOf('(allow file-read* (subpath (param "C0"))'));
  expect(params.some(([k]) => k.startsWith("E"))).toBe(false);
});

test("a project inside a denied secret (the guest workspace in ~/.tropos) gets no template allow that would reopen it", () => {
  const { profile } = sandboxProfile({ ...base, otherProjects: ["/u/.tropos/guest-workspace"] });
  expect(profile).toContain("[Gg][Uu][Ee][Ss][Tt]-[Ww][Oo][Rr][Kk][Ss][Pp][Aa][Cc][Ee]/(.*/)?\\.[Ee][Nn][Vv]([Rr][Cc]");
  expect(profile).not.toContain("[Gg][Uu][Ee][Ss][Tt]-[Ww][Oo][Rr][Kk][Ss][Pp][Aa][Cc][Ee]/(.*/)?\\.[Ee][Nn][Vv]\\.([Ee][Xx]");
});

test("thousands of other projects keep the profile small, and no regex reaches the sandbox's 1,024-character limit", () => {
  const otherProjects = Array.from({ length: 3_200 }, (_, i) => `/Users/someone/Projects/client-work/project-${i}`);
  const { profile, params } = sandboxProfile({ ...base, otherProjects });
  const empty = sandboxProfile(base).profile;
  expect(profile.length - empty.length).toBeLessThan(40_000);
  expect(params.some(([k]) => k.startsWith("E"))).toBe(false);
  for (const [, regex] of profile.matchAll(/#"([^"]*)"/g)) expect(regex!.length).toBeLessThan(1_024);
});

test("a project path too long to spell in every case is still denied, in its own case", () => {
  const long = `/w/${"deeply-nested-folder/".repeat(20)}other`;
  const { profile } = sandboxProfile({ ...base, otherProjects: [long], otherProjectSecrets: [`${long}-secrets/app.env`] });
  expect(profile).toContain(`(regex #"^/w/deeply-nested-folder/`);
  for (const [, regex] of profile.matchAll(/#"([^"]*)"/g)) expect(regex!.length).toBeLessThan(1_024);
});

test("another project's .env whose path the profile can't spell is still denied, by a pattern that stands in for the odd letter", () => {
  const { profile, params } = sandboxProfile({ ...base, otherProjectSecrets: ['/w/odd"name/.env', "/w/Straße/.env", "/w/ok/.env"] });
  // Only a path the profile can spell travels as a param; the others are matched by a regex alone.
  expect(params.filter(([k]) => k.startsWith("E")).map(([, v]) => v)).toEqual(["/w/ok/.env"]);
  const rule = ruleWith(profile, '(deny file-read* (subpath (param "E0"))');
  expect(rule).toContain('(regex #"^/[Ww]/[Oo][Dd][Dd][^/][^/]?[^/]?[Nn][Aa][Mm][Ee]/\\.[Ee][Nn][Vv](/.*)?$")');
  expect(rule).toContain('(regex #"^/[Ww]/[Ss][Tt][Rr][Aa][^/][^/]?[^/]?[Ee]/\\.[Ee][Nn][Vv](/.*)?$")');
});

const ruleWith = (profile: string, head: string) => {
  const line = profile.split("\n").find((l) => l.startsWith(head));
  if (!line) throw new Error(`no rule starting with ${head}`);
  return line;
};

test("the rules come in the order the sandbox needs: service denies, base write deny, allows, protections, read denies, carve-out last", () => {
  const { profile } = sandboxProfile(base);
  const order = [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound (remote unix-socket))",
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    "(deny mach-lookup",
    "(deny file-write*)",
    '(allow file-write* (subpath (param "PROJECT"))',
    '(deny file-write* (subpath (param "R0"))',
    '(allow file-write* (regex #"^/[Uu]/\\.[Tt][Rr][Oo][Pp][Oo][Ss]/[Ss][Aa][Nn][Dd][Bb][Oo][Xx]-[Cc][Aa][Cc][Hh][Ee]/.+"))',
    '(deny file-write* (literal (param "PROJECT"))',
    '(deny file-read* (subpath (param "R0"))',
    '(allow file-read* (subpath (param "C0")) (subpath (param "C1")) (subpath (param "CD0")) (regex',
    "(deny file-read* file-write* (subpath (param \"O0\")) (subpath (param \"O1\")))",
  ];
  const at = order.map((rule) => profile.indexOf(rule));
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  // The chief's own files are denied last, after the carve-out they sit in (the last match wins).
  expect(profile.trimEnd().endsWith('(deny file-read* file-write* (subpath (param "O0")) (subpath (param "O1")))')).toBe(true);
  // Host services: the keychain (securityd) over Mach and every Unix-socket connect (docker.sock, ssh/gpg agents).
  const mach = ruleWith(profile, "(deny mach-lookup");
  for (const svc of ['(global-name "com.apple.securityd")', '(global-name "com.apple.SecurityServer")']) expect(mach).toContain(svc);
  expect(mach).toContain('(global-name-regex #"^com\\.apple\\.security\\.")');
  const allow = ruleWith(profile, "(allow file-write*");
  for (const k of ["W0", "W1"]) expect(allow).toContain(`(subpath (param "${k}"))`);
  // The cache root itself is never writable, only its contents (so it can't be renamed or swapped for a link).
  expect(allow).not.toContain('(param "CD0")');
  for (const dev of ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/dtracehelper")', '(regex #"^/dev/(tty|fd/)")']) expect(allow).toContain(dev);
  const protect = ruleWith(profile, "(deny file-write* (literal");
  for (const k of ["G0", "G1"]) expect(protect).toContain(`(literal (param "${k}"))`);
  expect(protect).toContain('(literal (param "K0")) (subpath (param "K0"))');
  const reads = ruleWith(profile, "(deny file-read*");
  for (const k of ["R0", "R1", "R2"]) expect(reads).toContain(`(subpath (param "${k}"))`);
});

test("paths travel as params; only the any-case protection regexes embed an escaped path; a double quote is refused", () => {
  const paths = { ...base, project: "/w/a.b+c(d)[e]{f}^$|?*", gitDirs: ["/w/a.b+c(d)[e]{f}^$|?*/.git"], husky: ["/w/a.b+c(d)[e]{f}^$|?*/.husky"] };
  const { profile, params } = sandboxProfile(paths);
  expect(params).toEqual([
    ["PROJECT", paths.project],
    ["W0", base.writable[0]!],
    ["W1", base.writable[1]!],
    ["G0", paths.gitDirs[0]!],
    ["K0", paths.husky[0]!],
    ["R0", base.deniedReads[0]!],
    ["R1", base.deniedReads[1]!],
    ["R2", base.deniedReads[2]!],
    ["C0", base.readCarveOuts[0]!],
    ["C1", base.readCarveOuts[1]!],
    ["CD0", base.cacheDir],
    ["O0", base.ownFiles[0]!],
    ["O1", base.ownFiles[1]!],
  ]);
  // Escaped, and every letter in any case.
  const escaped = "/[Ww]/[Aa]\\.[Bb]\\+[Cc]\\([Dd]\\)\\[[Ee]\\]\\{[Ff]\\}\\^\\$\\|\\?\\*";
  const embedding = profile.split("\n").filter((l) => l.includes("/[Ww]/[Aa]"));
  expect(embedding).toEqual([
    `  (regex #"^${escaped}/\\.[Gg][Ii][Tt]/(.*/)?([Hh][Oo][Oo][Kk][Ss](/.*)?|[Cc][Oo][Nn][Ff][Ii][Gg](\\.[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee])?|[Cc][Oo][Mm][Mm][Oo][Nn][Dd][Ii][Rr])$")`,
    `  (regex #"^${escaped}$")`,
    `  (regex #"^${escaped}/\\.[Gg][Ii][Tt]$")`,
    `  (regex #"^${escaped}/\\.[Hh][Uu][Ss][Kk][Yy](/.*)?$")`,
    `  (regex #"^${escaped}/(.*/)?\\.[Tt][Rr][Oo][Pp][Oo][Ss](/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss](\\.[Ll][Oo][Cc][Aa][Ll])?\\.[Jj][Ss][Oo][Nn])?$")`,
  ]);
  for (const p of [...base.writable, ...base.deniedReads, ...base.readCarveOuts, base.cacheDir, ...base.ownFiles]) expect(profile).not.toContain(p);

  expect(() => sandboxProfile({ ...base, project: '/w/a"b' })).toThrow(new ConfinementError(`/w/a"b can't be confined: its path contains a double quote.`));
  expect(() => sandboxProfile({ ...base, gitDirs: ["/w/app/.git", '/w/app/g"it'] })).toThrow(ConfinementError);
});

test("secrets are write-protected too, except one that holds the project (Tropos's workspace)", () => {
  const inside = sandboxProfile({ ...base, project: "/u/.tropos/workspace", gitDirs: ["/u/.tropos/workspace/.git"], husky: ["/u/.tropos/workspace/.husky"] });
  const secretsDeny = ruleWith(inside.profile, '(deny file-write* (subpath (param "R');
  expect(secretsDeny).toContain('(subpath (param "R0"))');
  expect(secretsDeny).not.toContain('(subpath (param "R1"))'); // ~/.tropos holds the project; its other files sit outside every writable path
  expect(secretsDeny).toContain('(subpath (param "R2"))');
});

test("a non-owner's profile write-denies the workspace's instruction files among the last write rules; an owner's has no such rule", () => {
  const files = ["/u/.tropos/workspace/TROPOS.md", "/u/.tropos/workspace/CLAUDE.md"];
  const { profile, params } = sandboxProfile({ ...base, instructionFiles: files });
  expect(params).toContainEqual(["I0", files[0]!]);
  expect(params).toContainEqual(["I1", files[1]!]);
  const rule = ruleWith(profile, '(deny file-write* (literal (param "I0"))');
  expect(rule).toContain('(literal (param "I1"))');
  // After every write allow, so nothing reopens them.
  const lines = profile.split("\n");
  expect(lines.indexOf(rule)).toBeGreaterThan(lines.findLastIndex((l) => l.startsWith("(allow file-write*")));
  expect(sandboxProfile(base).profile).not.toContain('(param "I0")');
  // In any letter case too: `tropos.MD` is the same file on a case-insensitive disk.
  expect(rule).toContain('(regex #"^/[Uu]/\\.[Tt][Rr][Oo][Pp][Oo][Ss]/[Ww][Oo][Rr][Kk][Ss][Pp][Aa][Cc][Ee]/[Tt][Rr][Oo][Pp][Oo][Ss]\\.[Mm][Dd]$")');
  expect(profile).toContain('(regex #"^/[Uu]/\\.[Tt][Rr][Oo][Pp][Oo][Ss]/[Ww][Oo][Rr][Kk][Ss][Pp][Aa][Cc][Ee]/[Uu][Ss][Ee][Rr]\\.[Mm][Dd](/.*)?$")');
});

test("secret reads and writes are denied in any letter case, and the carve-outs reopen in any case after them", () => {
  const { profile } = sandboxProfile(base);
  const lines = profile.split("\n");
  const ssh = '(regex #"^/[Uu]/\\.[Ss][Ss][Hh](/.*)?$")';
  const readDeny = lines.findIndex((l) => l.startsWith("(deny file-read*") && l.includes(ssh));
  expect(readDeny).toBeGreaterThan(0);
  expect(lines.some((l) => l.startsWith("(deny file-write*") && l.includes(ssh))).toBe(true);
  const carve = lines.findIndex((l) => l.startsWith("(allow file-read*") && l.includes('(regex #"^/[Uu]/\\.[Tt][Rr][Oo][Pp][Oo][Ss]/[Ww][Oo][Rr][Kk][Ss][Pp][Aa][Cc][Ee](/.*)?$")'));
  expect(carve).toBeGreaterThan(readDeny);
});

test("a Greek path confines, matched in any case and in both NFC and NFD; a character whose case changes length is refused", () => {
  const ws = "/u/Έργα/.tropos/workspace";
  const { profile } = sandboxProfile({ ...base, deniedReads: ["/u/.ssh", "/u/Έργα/.tropos"], instructionFiles: [`${ws}/TROPOS.md`], project: "/w/Πάνος", gitDirs: ["/w/Πάνος/.git"], husky: ["/w/Πάνος/.husky"] });
  // Each letter is its upper and lower form (σ with ς and Σ); the NFD spelling (Ε + combining acute) is an alternative.
  expect(profile).toContain("(Π|π)(Ά|ά)(Ν|ν)(Ο|ο)(Σ|σ|ς)");
  expect(profile).toContain("(/[Uu]/(Έ|έ)(Ρ|ρ)");
  expect(profile).toContain("|/[Uu]/(Ε|ε)\u0301(Ρ|ρ)");
  for (const over of [{ deniedReads: ["/u/.ssh", "/u/Straße/.aws"] }, { project: "/w/ŉame", gitDirs: ["/w/ŉame/.git"], husky: ["/w/ŉame/.husky"] }]) {
    expect(() => sandboxProfile({ ...base, ...over })).toThrow(ConfinementError);
  }
  expect(() => sandboxProfile({ ...base, deniedReads: ["/u/Straße/.aws"] })).toThrow("changes length");
});

const sandboxExec = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
describe.skipIf(!sandboxExec)("under the real sandbox-exec", () => {
  const run = (paths: ConfinementPaths, script: string) => {
    const { profile, params } = sandboxProfile(paths);
    const r = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "/bin/sh", "-c", script], {
      cwd: paths.project,
      env: { PATH: "/usr/bin:/bin" },
      stderr: "pipe",
    });
    return r.exitCode;
  };
  const fixture = () => {
    const fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-sbx-")));
    const userHome = join(fx, "home");
    const project = join(fx, "p.r+o(j) [1]");
    for (const d of [join(userHome, ".ssh"), join(userHome, ".tropos", "workspace"), join(userHome, ".tropos", "sandbox-cache"), join(userHome, ".npm"), join(project, ".git", "hooks"), join(project, ".tropos"), join(fx, "tmp"), join(fx, "outside")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(userHome, ".ssh", "id"), "key");
    writeFileSync(join(userHome, ".tropos", "gateway.json"), "{}");
    writeFileSync(join(userHome, ".tropos", "workspace", "f"), "w");
    writeFileSync(join(userHome, ".npm", "cached"), "pkg");
    writeFileSync(join(project, ".git", "config"), "");
    writeFileSync(join(project, ".tropos", "settings.json"), "{}");
    return { fx, userHome, project };
  };

  test("a non-owner's command in the chief's workspace can't create or overwrite its instruction files; other files are fine", () => {
    const { fx, userHome } = fixture();
    try {
      const ws = join(userHome, ".tropos", "workspace");
      mkdirSync(join(ws, ".git"), { recursive: true });
      writeFileSync(join(ws, "CLAUDE.md"), "owner's");
      const home = join(userHome, ".tropos");
      const guarded = confinementPaths({ project: ws, home, userHome, env: { TMPDIR: join(fx, "tmp") }, protectInstructions: true });
      expect(run(guarded, "echo x > TROPOS.md")).not.toBe(0);
      expect(run(guarded, "echo x > CLAUDE.md")).not.toBe(0);
      expect(run(guarded, "echo x > TROPOS.local.md")).not.toBe(0);
      expect(run(guarded, "echo x > AGENTS.override.md")).not.toBe(0);
      expect(run(guarded, "echo x > notes.txt")).toBe(0);
      // The disk ignores case: a variant of the name is the same file and is refused too.
      expect(run(guarded, "echo x > tropos.MD")).not.toBe(0);
      expect(run(guarded, "echo x > Claude.md")).not.toBe(0);
      expect(run(guarded, `echo x > "${join(ws.toUpperCase(), "TROPOS.md")}"`)).not.toBe(0);
      expect(existsSync(join(ws, "TROPOS.md"))).toBe(false);
      const owner = confinementPaths({ project: ws, home, userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(owner, "echo x > TROPOS.md")).toBe(0);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("a project and a home at Greek paths confine, and the protections hold for case variants of the Greek names", () => {
    const fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-sbx-")));
    try {
      const userHome = join(fx, "Πάνος");
      const ws = join(userHome, ".tropos", "workspace");
      const project = join(fx, "Έργα", "app");
      for (const d of [join(userHome, ".ssh"), ws, join(project, ".git", "hooks"), join(fx, "tmp")]) mkdirSync(d, { recursive: true });
      writeFileSync(join(userHome, ".ssh", "id"), "key");
      writeFileSync(join(project, ".git", "config"), "");
      const paths = confinementPaths({ project, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, "echo a > ok.txt")).toBe(0);
      expect(run(paths, "echo a > .git/hooks/pre-commit")).not.toBe(0);
      expect(run(paths, `echo a > "${join(fx, "ΈΡΓΑ", "APP", ".GIT", "hooks", "pre-commit")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(fx, "ΠΆΝΟΣ", ".ssh", "id")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(fx, "πάνος", ".SSH", "id")}"`)).not.toBe(0);
      // A non-owner in the chief's workspace under the Greek home: the instruction files in any case.
      mkdirSync(join(ws, ".git"), { recursive: true });
      const guarded = confinementPaths({ project: ws, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") }, protectInstructions: true });
      expect(run(guarded, "echo x > notes.txt")).toBe(0);
      expect(run(guarded, "echo x > tropos.MD")).not.toBe(0);
      expect(run(guarded, `echo x > "${join(fx, "ΠΆΝΟΣ", ".tropos", "workspace", "Tropos.md")}"`)).not.toBe(0);
      expect(existsSync(join(ws, "TROPOS.md"))).toBe(false);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("an escaped project path still confines: hooks, commondir and settings are refused, ordinary files are not", () => {
    const { fx, userHome, project } = fixture();
    try {
      const paths = confinementPaths({ project, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, "echo a > ok.txt && mkdir -p src/deep && echo b > src/deep/x && rm ok.txt")).toBe(0);
      expect(run(paths, `echo a > "${join(fx, "tmp", "x")}"`)).toBe(0);
      expect(run(paths, `echo a > "${join(fx, "outside", "x")}"`)).not.toBe(0);
      expect(run(paths, "echo a > .git/hooks/pre-commit")).not.toBe(0);
      expect(run(paths, "echo a > .git/config")).not.toBe(0);
      expect(run(paths, "echo /elsewhere > .git/commondir")).not.toBe(0);
      expect(run(paths, "echo a > .git/HEAD.new")).toBe(0);
      expect(run(paths, "echo a > .GIT/hooks/pre-commit")).not.toBe(0);
      expect(run(paths, "echo a > .git/Hooks/post-checkout")).not.toBe(0);
      expect(run(paths, "echo a > .git/CONFIG")).not.toBe(0);
      expect(run(paths, "echo '{}' > .TROPOS/settings.json")).not.toBe(0);
      expect(run(paths, "echo '{}' > .tropos/settings.json")).not.toBe(0);
      expect(run(paths, "rm .tropos/settings.json")).not.toBe(0);
      expect(run(paths, "mv .tropos moved")).not.toBe(0);
      expect(run(paths, "mkdir -p sub/.tropos")).not.toBe(0);
      expect(run(paths, "echo a > .tropos/notes.md")).toBe(0);
      expect(run(paths, `cat "${join(userHome, ".ssh", "id")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".SSH", "id")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".TROPOS", "gateway.json")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".Tropos", "WORKSPACE", "f")}"`)).toBe(0);
      expect(run(paths, `cat "${join(userHome, ".tropos", "gateway.json")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".tropos", "workspace", "f")}"`)).toBe(0);
      expect(readdirSync(project).sort()).toEqual([".git", ".tropos", "src", "sub"]); // sub made by `mkdir -p`, its .tropos refused
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("the profile denies reading and writing workspace/USER.md and memory/ though the workspace is writable", () => {
    const { fx, userHome } = fixture();
    try {
      const ws = join(userHome, ".tropos", "workspace");
      mkdirSync(join(ws, "memory"), { recursive: true });
      writeFileSync(join(ws, "USER.md"), "secret about the user");
      writeFileSync(join(ws, "memory", "2026-10-16.md"), "journal");
      const paths = confinementPaths({ project: ws, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, `cat "${join(ws, "USER.md")}"`)).not.toBe(0);
      expect(run(paths, `echo x >> "${join(ws, "USER.md")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(ws, "memory", "2026-10-16.md")}"`)).not.toBe(0);
      expect(run(paths, `echo x > "${join(ws, "memory", "new.md")}"`)).not.toBe(0);
      expect(run(paths, `echo x > "${join(ws, "MEMORY.md")}"`)).not.toBe(0); // missing files can't be created either
      expect(existsSync(join(ws, "MEMORY.md"))).toBe(false);
      expect(run(paths, `mkdir "${join(ws, "skills")}"`)).not.toBe(0);
      expect(existsSync(join(ws, "skills"))).toBe(false);
      // A case variant of a name reaches the same file on this disk: refused the same way.
      expect(run(paths, `cat "${join(ws, "user.md")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(ws, "Memory", "2026-10-16.md")}"`)).not.toBe(0);
      expect(run(paths, `echo x > "${join(ws, "memory.MD")}"`)).not.toBe(0);
      // The rest of the workspace is still the project: readable and writable.
      expect(run(paths, `echo hi > "${join(ws, "app.ts")}" && cat "${join(ws, "app.ts")}"`)).toBe(0);
      // Seen from another project, the workspace carve-out stays readable but the chief's files do not.
      const other = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(other, `cat "${join(ws, "app.ts")}"`)).toBe(0);
      expect(run(other, `cat "${join(ws, "USER.md")}"`)).not.toBe(0);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("the per-sandbox cache is writable and readable; the owner's host cache is not writable", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, `echo pkg > "${join(paths.cacheDir, "x")}" && cat "${join(paths.cacheDir, "x")}"`)).toBe(0);
      expect(run(paths, `echo poison > "${join(userHome, ".npm", "cached")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".npm", "cached")}"`)).toBe(0); // host cache stays readable
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("host services are denied: the keychain and Unix-domain sockets", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      // A throwaway keychain with a secret; the lookup goes through securityd, which the profile blocks.
      const keychain = join(fx, "tk.keychain");
      Bun.spawnSync(["/usr/bin/security", "create-keychain", "-p", "x", keychain]);
      Bun.spawnSync(["/usr/bin/security", "add-generic-password", "-a", "me", "-s", "svc", "-w", "topsecret", keychain]);
      try {
        const open = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", "svc", "-w", keychain]);
        expect(open.stdout.toString().trim()).toBe("topsecret"); // reachable without the sandbox
        const { profile, params } = sandboxProfile(paths);
        const denied = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "/usr/bin/security", "find-generic-password", "-s", "svc", "-w", keychain], { cwd: paths.project, env: { PATH: "/usr/bin:/bin" } });
        expect(denied.stdout.toString()).not.toContain("topsecret");
      } finally {
        Bun.spawnSync(["/usr/bin/security", "delete-keychain", keychain]);
      }
      // A local Unix-domain socket a chat must not connect to (stands in for docker.sock / the ssh-agent socket).
      const sockDir = realpathSync(mkdtempSync(join("/tmp", "ts-")));
      const sock = join(sockDir, "s");
      const server = Bun.listen({ unix: sock, socket: { data() {} } });
      try {
        const script = `cat <<'PY' | /usr/bin/python3 -I -\nimport socket,sys\ns=socket.socket(socket.AF_UNIX)\ntry:\n  s.connect("${sock}"); print("CONNECTED")\nexcept Exception as e:\n  print("FAILED")\nPY`;
        const { profile, params } = sandboxProfile(paths);
        const r = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "/bin/sh", "-c", script], { cwd: paths.project, env: { PATH: "/usr/bin:/bin" } });
        expect(r.stdout.toString()).toContain("FAILED");
        expect(r.stdout.toString()).not.toContain("CONNECTED");
      } finally {
        server.stop(true);
        rmSync(sockDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  const py = (paths: ConfinementPaths, code: string) => {
    const { profile, params } = sandboxProfile(paths);
    const r = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "/usr/bin/python3", "-I", "-c", code], {
      cwd: paths.project,
      env: { PATH: "/usr/bin:/bin" },
      timeout: 20_000,
    });
    return r.stdout.toString().trim();
  };
  const resolves = (host: string) => `import socket\ntry:\n  socket.getaddrinfo(${JSON.stringify(host)}, 80); print("OK")\nexcept Exception as e:\n  print("FAILED", e)`;

  test("DNS still works: localhost resolves and a loopback TCP connect reaches a listener", () => {
    const { fx, userHome } = fixture();
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(py(paths, resolves("localhost"))).toBe("OK");
      const connect = `import socket\ns=socket.create_connection(("127.0.0.1", ${server.port}), timeout=5)\nprint("CONNECTED")`;
      expect(py(paths, connect)).toBe("CONNECTED");
    } finally {
      server.stop(true);
      rmSync(fx, { recursive: true, force: true });
    }
  });

  const online = Bun.spawnSync(["/usr/bin/python3", "-I", "-c", resolves("example.com")], { timeout: 10_000 }).stdout.toString().trim() === "OK";
  test.skipIf(!online)("a public host name resolves inside the sandbox (skipped offline)", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(py(paths, resolves("example.com"))).toBe("OK");
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("the cache's contents are writable but the cache dir itself can't be renamed or replaced", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, `echo a > "${join(paths.cacheDir, "npm", "x")}"`)).toBe(0);
      expect(run(paths, `mv "${paths.cacheDir}" "${paths.cacheDir}2"`)).not.toBe(0);
      expect(run(paths, `rm -rf "${paths.cacheDir}"`)).not.toBe(0);
      expect(existsSync(paths.cacheDir)).toBe(true);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("git and python still run under the profile (the service denies don't break them)", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, "/usr/bin/git --version >/dev/null && /usr/bin/python3 -c 'print(1)' >/dev/null")).toBe(0);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("a project that holds the user's home still can't write secrets or Tropos's home", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: userHome, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, "echo a > notes.txt")).toBe(0);
      expect(run(paths, "echo a > .ssh/authorized_keys")).not.toBe(0);
      expect(run(paths, "echo a > .tropos/gateway.json")).not.toBe(0);
      expect(run(paths, "mv .ssh ssh2")).not.toBe(0);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });
});

test("a worktree's referenced git dirs get the same hooks and config write protection", () => {
  const { profile, params } = sandboxProfile({ ...base, linkedGitDirs: ["/r/.git/worktrees/t1", "/r/.git"] });
  expect(params).toContainEqual(["G2", "/r/.git/worktrees/t1"]);
  // Every name in any letter case: a case-insensitive disk resolves `.GIT/Hooks` to the same folder.
  expect(profile).toContain('(regex #"^/[Rr]/\\.[Gg][Ii][Tt]/[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee][Ss]/[Tt]1/(.*/)?([Hh][Oo][Oo][Kk][Ss](/.*)?|[Cc][Oo][Nn][Ff][Ii][Gg](\\.[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee])?|[Cc][Oo][Mm][Mm][Oo][Nn][Dd][Ii][Rr])$")');
  expect(profile).toContain('(regex #"^/[Rr]/\\.[Gg][Ii][Tt]/(.*/)?([Hh][Oo][Oo][Kk][Ss](/.*)?|[Cc][Oo][Nn][Ff][Ii][Gg](\\.[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee])?|[Cc][Oo][Mm][Mm][Oo][Nn][Dd][Ii][Rr])$")');
});

test("a worktree git dir inside a writable path is refused, not confined weakly", () => {
  for (const dir of ["/w/app/inner/.git", "/private/tmp/r/.git", "/u/.tropos/sandbox-cache/r/.git"]) {
    expect(() => sandboxProfile({ ...base, linkedGitDirs: [dir] })).toThrow(ConfinementError);
  }
  expect(() => sandboxProfile({ ...base, linkedGitDirs: ["/r/.git"] })).not.toThrow();
});
