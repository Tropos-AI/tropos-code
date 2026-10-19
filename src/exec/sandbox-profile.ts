// src/exec/sandbox-profile.ts — the macOS sandbox-exec profile for a confined chat command.
//
// The last matching rule wins, so the order matters (verified with /usr/bin/sandbox-exec on macOS 26):
// everything allowed; host services denied (Unix sockets but DNS, the keychain); writes denied; writes reopened for
// the project and temp; secrets write-denied; the per-sandbox cache contents reopened; then the protections, last
// among the write rules so nothing can reopen them; then secret reads denied; then the workspace and cache readable; then the chief's own files denied again.
// Paths travel as -D params, never inlined, except where a rule needs a regex. Profile paths must be real paths:
// the sandbox matches resolved paths.
import { isInside } from "../paths";
import { ConfinementError, requireLinkedGitDirsOutsideWritable, type ConfinementPaths } from "./confinement-paths";

/** mDNSResponder's socket: every host-name lookup (getaddrinfo) goes through it. */
const DNS_SOCKET = "/private/var/run/mDNSResponder";

export interface SandboxProfile {
  profile: string;
  params: [string, string][];
}

export function sandboxProfile(paths: ConfinementPaths): SandboxProfile {
  requireLinkedGitDirsOutsideWritable(paths);
  // A `"` in any inlined or param path would break the SBPL quoting; refuse rather than emit a broken profile.
  for (const p of [paths.project, paths.cacheDir, ...paths.readCarveOuts, ...paths.ownFiles, ...paths.instructionFiles, ...paths.gitDirs, ...paths.linkedGitDirs, ...paths.husky, ...paths.writable, ...paths.deniedReads]) {
    if (p.includes('"')) throw new ConfinementError(`${p} can't be confined: its path contains a double quote.`);
  }
  const params: [string, string][] = [["PROJECT", paths.project]];
  const named = (prefix: string, list: string[]) =>
    list.map((path, i) => {
      params.push([`${prefix}${i}`, path]);
      return `(param "${prefix}${i}")`;
    });
  const writable = named("W", paths.writable);
  const gitDirs = named("G", [...paths.gitDirs, ...paths.linkedGitDirs]);
  const husky = named("K", paths.husky);
  const secrets = named("R", paths.deniedReads);
  const carveOuts = named("C", paths.readCarveOuts);
  params.push(["CD0", paths.cacheDir]);
  const ownFiles = named("O", paths.ownFiles);
  const instructionFiles = named("I", paths.instructionFiles);

  // A secret that holds the project (Tropos's home around its workspace) can't be write-denied without denying the
  // project; the rest of it lies outside every writable path anyway.
  const writeDeniedSecrets = secrets.filter((_, i) => !isInside(paths.project, paths.deniedReads[i]!));
  const protections = [
    // The literal dirs: renaming .git (or the project) away, writing hooks, and renaming it back is refused.
    `(literal (param "PROJECT"))`,
    ...gitDirs.map((p) => `(literal ${p})`),
    ...husky.map((p) => `(literal ${p}) (subpath ${p})`),
  ].join(" ");
  const regexes = [
    // Hooks and config in the repo and in every nested git dir (submodules under modules/, worktrees/), and the
    // commondir pointer, which would move where git looks for both.
    ...[...paths.gitDirs, ...paths.linkedGitDirs].map((g) => `(regex #"^${escapeRegex(g)}/(.*/)?(hooks(/.*)?|config(\\.worktree)?|commondir)$")`),
    // The repo's own settings hold its deny rules; a shell redirect must not strip them (the folder can't be renamed either).
    `(regex #"^${escapeRegex(paths.project)}/(.*/)?\\.tropos(/settings(\\.local)?\\.json)?$")`,
  ];

  const writeAllow = [`(subpath (param "PROJECT"))`, ...writable.map((p) => `(subpath ${p})`)];
  const profile = [
    "(version 1)",
    "(allow default)",
    // Host services a chat must not reach: the Docker daemon, ssh-agent and gpg-agent (Unix sockets), and the
    // keychain (securityd over Mach). DNS goes through mDNSResponder's socket, so that one stays reachable.
    `(deny network-outbound (remote unix-socket))`,
    `(allow network-outbound (remote unix-socket (path-literal "${DNS_SOCKET}")))`,
    `(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.SecurityServer") (global-name-regex #"^com\\.apple\\.security\\."))`,
    "(deny file-write*)",
    `(allow file-write* ${writeAllow.join(" ")} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/(tty|fd/)"))`,
    ...(writeDeniedSecrets.length > 0 ? [`(deny file-write* ${writeDeniedSecrets.map((p) => `(subpath ${p})`).join(" ")})`] : []),
    // The cache's contents, not the cache dir itself (it can't be renamed or replaced by a link). It sits inside the
    // write-denied ~/.tropos, so it comes after that deny, and before the protections so it can never reopen them.
    `(allow file-write* (regex #"^${escapeRegex(paths.cacheDir)}/.+"))`,
    `(deny file-write* ${protections}`,
    ...regexes.map((r) => `  ${r}`),
    ")",
    // A non-owner's session: the instruction files the owner's sessions load from the workspace, missing ones included.
    ...(instructionFiles.length > 0 ? [`(deny file-write* ${instructionFiles.map((p) => `(literal ${p})`).join(" ")})`] : []),
    // subpath matches the path itself too, so this covers files and folders alike.
    `(deny file-read* ${secrets.map((p) => `(subpath ${p})`).join(" ")})`,
    // Carve back out, after the secret read-deny: the default project, the chats' worktrees and the per-sandbox cache (inside ~/.tropos).
    `(allow file-read* ${carveOuts.map((p) => `(subpath ${p})`).join(" ")} (subpath (param "CD0")))`,
    // The chief's own files sit inside that workspace (and may be the project itself): last, so nothing reopens them.
    ...(ownFiles.length > 0 ? [`(deny file-read* file-write* ${ownFiles.map((p) => `(subpath ${p})`).join(" ")})`] : []),
    "",
  ].join("\n");
  return { profile, params };
}

function escapeRegex(path: string): string {
  return path.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}
