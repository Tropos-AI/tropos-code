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
  // The owner's other projects: one pattern for all their roots denies their .env files at any depth, ones created
  // later included, and keeps the profile small (the sandbox compiles it again for every command, so a rule per file
  // made each command slower with every file). Committed templates stay readable. A path the profile can't spell (a
  // `"`, a letter like ß) gets a short wildcard for that letter, rather than refusing every session over another
  // project's name; the wildcard may deny a few more files, never fewer.
  const spellable = (p: string) => !p.includes('"') && !lengthChangingLetter(p);
  const envLeaf = `\\.${anyCase("env")}(${anyCase("rc")}|\\.[^/]+)?`;
  const envTemplate = `\\.${anyCase("env")}\\.(${anyCase("example")}|${anyCase("sample")}|${anyCase("template")})`;
  // A project inside another one is covered by it, which also keeps any root from being a prefix of another.
  const outermost = (list: readonly string[]) => list.filter((root) => !list.some((other) => other !== root && isInside(root, other)));
  const roots = outermost(paths.otherProjects);
  const shallow = outermost(paths.otherProjectsShallow);
  // Never inside a denied secret (the guest workspace inside ~/.tropos): the allow would reopen a file there.
  const reopenable = (root: string) => !paths.deniedReads.some((secret) => isInside(root, secret));
  const envDenies = [
    ...rootRegexes(roots, `(.*/)?${envLeaf}$`, "deny"),
    // A project holding the home: two folders deep at most, or the pattern would cover every project of the user's.
    ...rootRegexes(shallow, `([^/]+/)?([^/]+/)?${envLeaf}$`, "deny"),
  ].map((r) => `(regex #"${r}")`);
  const envReopens = [
    ...rootRegexes([...roots, ...shallow].filter(reopenable), `(.*/)?${envTemplate}$`, "allow"),
    // The session's own .env files, when a project holding the home lies around it.
    ...(shallow.some((root) => isInside(paths.project, root)) ? rootRegexes([paths.project], `(.*/)?${envLeaf}$`, "allow") : []),
  ].map((r) => `(regex #"${r}")`);
  // Concrete paths: where linked .env files point, and on a platform without patterns the files themselves.
  const envFiles = named("E", paths.otherProjectSecrets.filter(spellable));
  const envPatterns = paths.otherProjectSecrets.map((p) => `(regex #"${fitDeny(p, "(/.*)?$")}")`);

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
    // Other projects' .env files, after the carve-out: the default project is usually one of them. Then their templates
    // reopened, then the targets of linked .env files denied again (a link may point at a template-named file).
    ...(envDenies.length > 0 ? [`(deny file-read* ${envDenies.join(" ")})`] : []),
    ...(envReopens.length > 0 ? [`(allow file-read* ${envReopens.join(" ")})`] : []),
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

/** sandbox-exec refuses a string of 1024 characters or more (verified with /usr/bin/sandbox-exec on macOS 26). */
const MAX_REGEX = 1000;

/**
 * A deny `^<path><rest>` within MAX_REGEX, in any letter case: the whole path when it fits, else as much of its start as
 * fits followed by anything, which denies more, never less. Never the path in one letter case only: on a
 * case-insensitive disk another spelling would reach the same file.
 */
function fitDeny(path: string, rest: string): string {
  const forms = caseTokens(path);
  const render = (count: number) => {
    const trie: Trie = new Map();
    for (const tokens of forms) insertTokens(trie, tokens.slice(0, count));
    return renderTrie(trie);
  };
  const longest = Math.max(...forms.map((tokens) => tokens.length));
  const whole = `^${render(longest)}${rest}`;
  if (whole.length <= MAX_REGEX) return whole;
  let count = longest;
  while (count > 1 && `^${render(count)}.*${rest}`.length > MAX_REGEX) count--;
  const cut = `^${render(count)}.*${rest}`;
  if (cut.length > MAX_REGEX) throw new ConfinementError(`${path} can't be confined: its rule doesn't fit in the sandbox's profile.`);
  return cut;
}

/**
 * Regexes `^<root>/<rest>` for all the roots, as few as fit MAX_REGEX each: roots go into one alternation (sharing
 * their prefixes) until the next would make it too long. Each root must lie in no other. A root too long to spell
 * alone is denied by its start (fitDeny) in a deny, and left out of an allow, which then reopens nothing for it.
 */
function rootRegexes(roots: readonly string[], rest: string, kind: "deny" | "allow"): string[] {
  const out: string[] = [];
  let chunk: string[][] = [];
  let trie: Trie = new Map();
  const render = () => `^${renderTrie(trie)}${rest}`;
  for (const root of [...roots].sort()) {
    const forms = caseTokens(`${root}/`);
    for (const tokens of forms) insertTokens(trie, tokens);
    if (render().length <= MAX_REGEX) {
      chunk.push(...forms);
      continue;
    }
    // Too long with this root: close the chunk without it, and start the next one with it.
    if (chunk.length > 0) {
      trie = new Map();
      for (const tokens of chunk) insertTokens(trie, tokens);
      out.push(render());
    }
    trie = new Map();
    for (const tokens of forms) insertTokens(trie, tokens);
    chunk = forms;
    if (render().length > MAX_REGEX) {
      if (kind === "deny") out.push(fitDeny(`${root}/`, rest));
      chunk = [];
      trie = new Map();
    }
  }
  if (chunk.length > 0) out.push(render());
  return out;
}

/** A trie of regex tokens: one per character of a path, in any letter case. */
type Trie = Map<string, Trie>;

/**
 * A path's characters as regex tokens in any letter case, once per spelling (NFC and NFD, when they differ). A letter
 * the profile can't spell (a `"`, a letter like ß) becomes a short wildcard: `{m,n}` bounds don't work in sandbox regexes.
 */
function caseTokens(path: string): string[][] {
  const forms = [...new Set([path.normalize("NFC"), path.normalize("NFD")])];
  return forms.map((form) => [...form].map((ch) => (ch === '"' || lengthChangingLetter(ch) ? "[^/][^/]?[^/]?" : anyCaseForm(ch))));
}

function insertTokens(trie: Trie, tokens: readonly string[]): void {
  let node = trie;
  for (const token of tokens) {
    let next = node.get(token);
    if (!next) node.set(token, (next = new Map()));
    node = next;
  }
}

/** The trie as one alternation: the prefix the paths share is spelled out once. The paths must not be prefixes of one another. */
function renderTrie(node: Trie): string {
  const branches = [...node].map(([token, next]) => token + renderTrie(next));
  return branches.length <= 1 ? (branches[0] ?? "") : `(${branches.join("|")})`;
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
