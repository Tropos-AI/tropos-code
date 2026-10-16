// src/exec/sandbox-profile.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfinementError, type ConfinementPaths, confinementPaths } from "./confinement-paths";
import { sandboxProfile } from "./sandbox-profile";

const base: ConfinementPaths = {
  project: "/w/app",
  writable: ["/private/var/folders/x/y/T", "/private/tmp", "/u/.npm"],
  gitDirs: ["/w/app/.git", "/w/app/realgit"],
  husky: ["/w/app/.husky"],
  deniedReads: ["/u/.ssh", "/u/.tropos", "/Library/Keychains"],
  readCarveOut: "/u/.tropos/workspace",
  platform: "darwin",
};

const ruleWith = (profile: string, head: string) => {
  const line = profile.split("\n").find((l) => l.startsWith(head));
  if (!line) throw new Error(`no rule starting with ${head}`);
  return line;
};

test("the rules come in the order the sandbox needs: base write deny, allows, protections, read denies, carve-out last", () => {
  const { profile } = sandboxProfile(base);
  const order = ["(version 1)", "(allow default)", "(deny file-write*)", "(allow file-write* (subpath (param \"PROJECT\"))", "(deny file-write* (literal (param \"PROJECT\"))", "(deny file-read* (subpath (param \"R0\"))", "(allow file-read* (subpath (param \"C0\")))"];
  const at = order.map((rule) => profile.indexOf(rule));
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(profile.trimEnd().endsWith('(allow file-read* (subpath (param "C0")))')).toBe(true);
  const allow = ruleWith(profile, "(allow file-write*");
  for (const k of ["W0", "W1", "W2"]) expect(allow).toContain(`(subpath (param "${k}"))`);
  for (const dev of ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/dtracehelper")', '(regex #"^/dev/(tty|fd/)")']) expect(allow).toContain(dev);
  const protect = ruleWith(profile, "(deny file-write* (literal");
  for (const k of ["G0", "G1"]) expect(protect).toContain(`(literal (param "${k}"))`);
  expect(protect).toContain('(literal (param "K0")) (subpath (param "K0"))');
  const reads = ruleWith(profile, "(deny file-read*");
  for (const k of ["R0", "R1", "R2"]) expect(reads).toContain(`(subpath (param "${k}"))`);
});

test("paths travel as params; only the git and settings regexes embed an escaped path; a double quote is refused", () => {
  const paths = { ...base, project: "/w/a.b+c(d)[e]{f}^$|?*", gitDirs: ["/w/a.b+c(d)[e]{f}^$|?*/.git"], husky: ["/w/a.b+c(d)[e]{f}^$|?*/.husky"] };
  const { profile, params } = sandboxProfile(paths);
  expect(params).toEqual([
    ["PROJECT", paths.project],
    ["W0", base.writable[0]!],
    ["W1", base.writable[1]!],
    ["W2", base.writable[2]!],
    ["G0", paths.gitDirs[0]!],
    ["K0", paths.husky[0]!],
    ["R0", base.deniedReads[0]!],
    ["R1", base.deniedReads[1]!],
    ["R2", base.deniedReads[2]!],
    ["C0", base.readCarveOut],
  ]);
  const escaped = "/w/a\\.b\\+c\\(d\\)\\[e\\]\\{f\\}\\^\\$\\|\\?\\*";
  const embedding = profile.split("\n").filter((l) => l.includes("/w/a"));
  expect(embedding).toEqual([
    `  (regex #"^${escaped}/\\.git/(.*/)?(hooks(/.*)?|config(\\.worktree)?|commondir)$")`,
    `  (regex #"^${escaped}/(.*/)?\\.tropos(/settings(\\.local)?\\.json)?$")`,
  ]);
  for (const p of [...base.writable, ...base.deniedReads, base.readCarveOut]) expect(profile).not.toContain(p);

  expect(() => sandboxProfile({ ...base, project: '/w/a"b' })).toThrow(new ConfinementError(`/w/a"b can't be confined: its path contains a double quote.`));
  expect(() => sandboxProfile({ ...base, gitDirs: ["/w/app/.git", '/w/app/g"it'] })).toThrow(ConfinementError);
});

test("secrets are write-protected too, except one that holds the project (Tropos's workspace)", () => {
  const inside = sandboxProfile({ ...base, project: "/u/.tropos/workspace", gitDirs: ["/u/.tropos/workspace/.git"], husky: ["/u/.tropos/workspace/.husky"] });
  const protect = ruleWith(inside.profile, "(deny file-write* (literal");
  expect(protect).toContain('(subpath (param "R0"))');
  expect(protect).not.toContain('(subpath (param "R1"))'); // ~/.tropos holds the project; its other files sit outside every writable path
  expect(protect).toContain('(subpath (param "R2"))');
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
    for (const d of [join(userHome, ".ssh"), join(userHome, ".tropos", "workspace"), join(project, ".git", "hooks"), join(project, ".tropos"), join(fx, "tmp"), join(fx, "outside")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(userHome, ".ssh", "id"), "key");
    writeFileSync(join(userHome, ".tropos", "gateway.json"), "{}");
    writeFileSync(join(userHome, ".tropos", "workspace", "f"), "w");
    writeFileSync(join(project, ".git", "config"), "");
    writeFileSync(join(project, ".tropos", "settings.json"), "{}");
    return { fx, userHome, project };
  };

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
      expect(run(paths, "echo '{}' > .tropos/settings.json")).not.toBe(0);
      expect(run(paths, "rm .tropos/settings.json")).not.toBe(0);
      expect(run(paths, "mv .tropos moved")).not.toBe(0);
      expect(run(paths, "mkdir -p sub/.tropos")).not.toBe(0);
      expect(run(paths, "echo a > .tropos/notes.md")).toBe(0);
      expect(run(paths, `cat "${join(userHome, ".ssh", "id")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".tropos", "gateway.json")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".tropos", "workspace", "f")}"`)).toBe(0);
      expect(readdirSync(project).sort()).toEqual([".git", ".tropos", "src", "sub"]); // sub made by `mkdir -p`, its .tropos refused
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
