// src/exec/sandbox-profile.ts — the macOS sandbox-exec profile for a confined chat command.
//
// The last matching rule wins, so the order matters (verified with /usr/bin/sandbox-exec on macOS 26):
// everything allowed; host services denied (Unix sockets but DNS, the keychain); writes denied; writes reopened for
// the project and temp; secrets write-denied; the per-sandbox cache contents reopened; then the protections, last
// among the write rules so nothing can reopen them; then secret reads denied; then the workspace and cache readable; then other projects' .env files denied; then the chief's own files denied again.
// Protected names are also matched in any letter case, as a case-insensitive disk resolves them.
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
    // The protections also match every letter case (anyCase); a letter whose other case is longer (ß → SS) can't be.
    const odd = lengthChangingLetter(p);
    if (odd) throw new ConfinementError(`${p} can't be confined: its letter "${odd}" changes length between upper and lower case, so the sandbox can't match it in every case.`);
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
  // Found by a search of the owner's other projects. One the profile can't spell (a `"`, a letter like ß) is still
  // denied, by a regex alone with a short wildcard for that letter, rather than refusing every session over another
  // project's file name; the wildcard may deny a few more of that project's files, never fewer.
  const spellable = (p: string) => !p.includes('"') && !lengthChangingLetter(p);
  const envFiles = named("E", paths.otherProjectSecrets.filter(spellable));
  const envPatterns = paths.otherProjectSecrets.map((p) => `(regex #"^${spellable(p) ? anyCase(p) : looseAnyCase(p)}(/.*)?$")`);

  // A secret that holds the project (Tropos's home around its workspace) can't be write-denied without denying the
  // project; the rest of it lies outside every writable path anyway.
  const writeDeniedSecrets = secrets.filter((_, i) => !isInside(paths.project, paths.deniedReads[i]!));
  const writeDeniedSecretPaths = paths.deniedReads.filter((p) => !isInside(paths.project, p));
  const protections = [
    // The literal dirs: renaming .git (or the project) away, writing hooks, and renaming it back is refused.
    `(literal (param "PROJECT"))`,
    ...gitDirs.map((p) => `(literal ${p})`),
    ...husky.map((p) => `(literal ${p}) (subpath ${p})`),
  ].join(" ");
  // macOS disks usually ignore case, so every name below is matched in any case: `.GIT/Hooks` is `.git/hooks`.
  const regexes = [
    // Hooks and config in the repo and in every nested git dir (submodules under modules/, worktrees/), and the
    // commondir pointer, which would move where git looks for both.
    ...[...paths.gitDirs, ...paths.linkedGitDirs].map((g) => `(regex #"^${anyCase(g)}/(.*/)?(${anyCase("hooks")}(/.*)?|${anyCase("config")}(\\.${anyCase("worktree")})?|${anyCase("commondir")})$")`),
    // The literal protections again, in any case.
    `(regex #"^${anyCase(paths.project)}$")`,
    ...paths.gitDirs.map((g) => `(regex #"^${anyCase(g)}$")`),
    ...paths.husky.map((h) => `(regex #"^${anyCase(h)}(/.*)?$")`),
    // The repo's own settings hold its deny rules; a shell redirect must not strip them (the folder can't be renamed either).
    `(regex #"^${anyCase(paths.project)}/(.*/)?\\.${anyCase("tropos")}(/${anyCase("settings")}(\\.${anyCase("local")})?\\.${anyCase("json")})?$")`,
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
    ...(writeDeniedSecrets.length > 0 ? [`(deny file-write* ${writeDeniedSecrets.map((p) => `(subpath ${p})`).join(" ")} ${writeDeniedSecretPaths.map(anyCaseSubpath).join(" ")})`] : []),
    // The cache's contents, not the cache dir itself (it can't be renamed or replaced by a link). It sits inside the
    // write-denied ~/.tropos, so it comes after that deny, and before the protections so it can never reopen them.
    `(allow file-write* (regex #"^${anyCase(paths.cacheDir)}/.+"))`,
    `(deny file-write* ${protections}`,
    ...regexes.map((r) => `  ${r}`),
    ")",
    // A non-owner's session: the instruction files the owner's sessions load from the workspace, missing ones included.
    ...(instructionFiles.length > 0 ? [`(deny file-write* ${instructionFiles.map((p) => `(literal ${p})`).join(" ")} ${paths.instructionFiles.map((p) => `(regex #"^${anyCase(p)}$")`).join(" ")})`] : []),
    // subpath matches the path itself too, so this covers files and folders alike.
    `(deny file-read* ${secrets.map((p) => `(subpath ${p})`).join(" ")} ${paths.deniedReads.map(anyCaseSubpath).join(" ")})`,
    // Carve back out, after the secret read-deny: the default project, the chats' worktrees and the per-sandbox cache (inside ~/.tropos).
    `(allow file-read* ${carveOuts.map((p) => `(subpath ${p})`).join(" ")} (subpath (param "CD0")) ${[...paths.readCarveOuts, paths.cacheDir].map(anyCaseSubpath).join(" ")})`,
    // Other projects' .env files (or whole projects), after the carve-out: the default project is usually one of them.
    ...(envPatterns.length > 0 ? [`(deny file-read* ${[...envFiles.map((p) => `(subpath ${p})`), ...envPatterns].join(" ")})`] : []),
    // The chief's own files sit inside that workspace (and may be the project itself): last, so nothing reopens them.
    ...(ownFiles.length > 0
      ? [
          `(deny file-read* file-write* ${paths.ownFiles.map((p) => `(regex #"^${anyCase(p)}(/.*)?$")`).join(" ")})`,
          `(deny file-read* file-write* ${ownFiles.map((p) => `(subpath ${p})`).join(" ")})`,
        ]
      : []),
    "",
  ].join("\n");
  return { profile, params };
}

function escapeRegex(path: string): string {
  return path.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/** `(subpath p)` in any letter case: the path itself and everything below it. */
function anyCaseSubpath(path: string): string {
  return `(regex #"^${anyCase(path)}(/.*)?$")`;
}

const SIGMAS = ["Σ", "σ", "ς"];

/** A letter's upper and lower forms (σ, ς and Σ together); one entry for anything without case. */
function caseForms(ch: string): string[] {
  if (SIGMAS.includes(ch)) return SIGMAS;
  return [...new Set([ch.toUpperCase(), ch.toLowerCase(), ch])];
}

/** The first character, in either normal form, whose case mapping is not one code point (ß → SS, ŉ → ʼN, İ → i̇). */
function lengthChangingLetter(path: string): string | undefined {
  for (const form of [path.normalize("NFC"), path.normalize("NFD")]) {
    for (const ch of form) if ([ch.toUpperCase(), ch.toLowerCase()].some((c) => [...c].length !== 1)) return ch;
  }
  return undefined;
}

/** One spelling of the path in any case: ASCII letters as `[Tt]`, other letters as `(Ε|ε)`, the rest escaped. */
function anyCaseForm(path: string): string {
  let out = "";
  for (const ch of path) {
    const forms = caseForms(ch);
    if (forms.length === 1) out += escapeRegex(ch);
    // Alternation, not a bracket class, beyond ASCII: a class of multi-byte characters may match single bytes.
    else out += /^[A-Za-z]$/.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : `(${forms.join("|")})`;
  }
  return out;
}

/** anyCase for a path it can't spell: each `"` and each letter whose case changes its length becomes a short wildcard. */
function looseAnyCase(path: string): string {
  const form = (p: string) => [...p].map((ch) => (ch === '"' || lengthChangingLetter(ch) ? "[^/][^/]?[^/]?" : anyCaseForm(ch))).join("");
  const nfc = form(path.normalize("NFC"));
  const nfd = form(path.normalize("NFD"));
  return nfc === nfd ? nfc : `(${nfc}|${nfd})`;
}

/**
 * The path as a regex that matches it in any letter case (`[Tt][Rr]…`, `(Ε|ε)(Ρ|ρ)…`), the way a case-insensitive disk
 * treats them as one file; a non-ASCII path in both its NFC and NFD spellings, which the disk treats as one name too.
 */
function anyCase(path: string): string {
  const nfc = anyCaseForm(path.normalize("NFC"));
  const nfd = anyCaseForm(path.normalize("NFD"));
  return nfc === nfd ? nfc : `(${nfc}|${nfd})`;
}
