// src/exec/sandbox-profile.ts — the macOS sandbox-exec profile for a confined chat command.
//
// The last matching rule wins, so the order matters (verified with /usr/bin/sandbox-exec on macOS 26):
// everything allowed; writes denied; writes reopened for the project, temp and caches; then the protections inside
// them; then secret reads denied; then Tropos's default project readable again. Paths travel as -D params, never
// inlined, except where a rule needs a regex. Profile paths must be real paths: the sandbox matches resolved paths.
import { isInside } from "../paths";
import { ConfinementError, type ConfinementPaths } from "./confinement-paths";

export interface SandboxProfile {
  profile: string;
  params: [string, string][];
}

export function sandboxProfile(paths: ConfinementPaths): SandboxProfile {
  for (const p of [paths.project, ...paths.gitDirs]) {
    if (p.includes('"')) throw new ConfinementError(`${p} can't be confined: its path contains a double quote.`);
  }
  const params: [string, string][] = [["PROJECT", paths.project]];
  const named = (prefix: string, list: string[]) =>
    list.map((path, i) => {
      params.push([`${prefix}${i}`, path]);
      return `(param "${prefix}${i}")`;
    });
  const writable = named("W", paths.writable);
  const gitDirs = named("G", paths.gitDirs);
  const husky = named("K", paths.husky);
  const secrets = named("R", paths.deniedReads);
  params.push(["C0", paths.readCarveOut]);

  // A secret that holds the project (Tropos's home around its workspace) can't be write-denied without denying the
  // project; the rest of it lies outside every writable path anyway.
  const writeDeniedSecrets = secrets.filter((_, i) => !isInside(paths.project, paths.deniedReads[i]!));
  const protections = [
    // The literal dirs: renaming .git (or the project) away, writing hooks, and renaming it back is refused.
    `(literal (param "PROJECT"))`,
    ...gitDirs.map((p) => `(literal ${p})`),
    ...husky.map((p) => `(literal ${p}) (subpath ${p})`),
    ...writeDeniedSecrets.map((p) => `(subpath ${p})`),
  ].join(" ");
  const regexes = [
    // Hooks and config in the repo and in every nested git dir (submodules under modules/, worktrees/), and the
    // commondir pointer, which would move where git looks for both.
    ...paths.gitDirs.map((g) => `(regex #"^${escapeRegex(g)}/(.*/)?(hooks(/.*)?|config(\\.worktree)?|commondir)$")`),
    // The repo's own settings hold its deny rules; a shell redirect must not strip them (the folder can't be renamed either).
    `(regex #"^${escapeRegex(paths.project)}/(.*/)?\\.tropos(/settings(\\.local)?\\.json)?$")`,
  ];

  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath (param "PROJECT")) ${writable.map((p) => `(subpath ${p})`).join(" ")} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/(tty|fd/)"))`,
    `(deny file-write* ${protections}`,
    ...regexes.map((r) => `  ${r}`),
    ")",
    // subpath matches the path itself too, so this covers files and folders alike.
    `(deny file-read* ${secrets.map((p) => `(subpath ${p})`).join(" ")})`,
    `(allow file-read* (subpath (param "C0")))`,
    "",
  ].join("\n");
  return { profile, params };
}

function escapeRegex(path: string): string {
  return path.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}
