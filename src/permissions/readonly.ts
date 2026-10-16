// src/permissions/readonly.ts
// Decides which shell commands a chat at the `balanced` level may run without asking.
import { resolve } from "node:path";
import { expandHome, isInside } from "../paths";
import { hasLeadingPrefix, isCodeRunner, splitBashCommand } from "./rules";

// Conservative on purpose: unknown means not read-only. A command, subcommand or option that is
// not listed here asks, so adding to these lists needs the same care as writing a permission rule.

/** Commands that cannot write or run other code whatever their arguments are. */
const PLAIN: ReadonlySet<string> = new Set([
  "cd", "ls", "pwd", "echo", "printf", "true", "false", "cat", "head", "tail", "wc", "stat", "du", "df",
  "basename", "dirname", "realpath", "readlink", "which", "type", "uname", "whoami", "id", "printenv", "grep", "egrep",
  "fgrep", "cut", "tr", "nl", "comm", "cmp", "diff", "od", "hexdump", "md5", "md5sum", "shasum", "sha1sum", "sha256sum",
  "column", "jq",
]);

const FIND_FORBIDDEN: ReadonlySet<string> = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls",
]);

const GIT_GLOBAL: ReadonlySet<string> = new Set(["--no-pager", "-P"]);
const GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "blame", "shortlog", "describe", "cat-file", "grep",
]);
const GIT_BRANCH_ARGS: ReadonlySet<string> = new Set([
  "-a", "-r", "-v", "-vv", "--all", "--remotes", "--verbose", "--list", "--show-current", "--no-color", "--color",
]);
/** `--output` writes a file, `--ext-diff` runs a configured program, `--exec` runs a command. */
const GIT_FORBIDDEN_LONG = ["--output*", "--ext-diff", "--exec*"];

/** The only redirects a read-only part may carry (besides `<file`, checked separately). */
const SAFE_REDIRECTS: ReadonlySet<string> = new Set(["2>&1", ">&2", ">/dev/null", "2>/dev/null", "&>/dev/null"]);

interface Word {
  /** As written, quotes included. */
  raw: string;
  /** After quote removal. */
  text: string;
  /** Held an unquoted glob or brace character, so the shell may turn it into other words. */
  glob: boolean;
  /** Held an unquoted `{`: brace expansion we do not model. */
  brace: boolean;
  /** Held an unquoted `<` or `>`. */
  redirect: boolean;
}

/**
 * Splits one simple command (a part from splitBashCommand, which has already refused
 * substitutions, heredocs and unsafe redirects) into words. Only space and tab separate
 * words, as in the shell. A leading unquoted `^` counts as a glob: zsh's extended glob negation.
 */
function splitWords(part: string): Word[] {
  const words: Word[] = [];
  let word: Word | null = null;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < part.length; i++) {
    const ch = part[i]!;
    if (quote === null && (ch === " " || ch === "\t")) {
      if (word) words.push(word);
      word = null;
      continue;
    }
    word ??= { raw: "", text: "", glob: false, brace: false, redirect: false };
    word.raw += ch;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word.text += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < part.length && '$`"\\\n'.includes(part[i + 1]!)) {
        word.raw += part[++i];
        word.text += part[i];
      } else word.text += ch;
    } else if (ch === "\\" && i + 1 < part.length) {
      word.raw += part[++i];
      word.text += part[i];
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else {
      if ("*?[{".includes(ch) || (ch === "^" && word.raw.length === 1)) word.glob = true;
      if (ch === "{") word.brace = true;
      if (ch === "<" || ch === ">") word.redirect = true;
      word.text += ch;
    }
  }
  if (word) words.push(word);
  return words;
}

/** A short-option word containing any of `letters`; getopt bundles them, so `-ro out` is `-r -o out`. */
function hasShort(text: string, letters: string): boolean {
  return text.length > 1 && text[0] === "-" && text[1] !== "-" && [...text.slice(1)].some((c) => letters.includes(c));
}

/**
 * A long option that is, or abbreviates, a forbidden one: getopt_long accepts any unique
 * prefix (`sort --out=x` writes x). An entry ending in `*` also forbids every longer name.
 */
function hasLong(text: string, forbidden: readonly string[]): boolean {
  if (!text.startsWith("--") || text.length <= 2) return false;
  const name = text.split("=")[0]!;
  return forbidden.some((f) => {
    const base = f.endsWith("*") ? f.slice(0, -1) : f;
    return base.startsWith(name) || (f.endsWith("*") ? name.startsWith(base) : name === base);
  });
}

function acceptedRedirect(word: Word): boolean {
  if (SAFE_REDIRECTS.has(word.raw)) return true;
  // `<file` reads a file; a second operator inside it (`<a>b`, `<>f`, `<&3`) is something else.
  return word.raw.length > 1 && word.raw[0] === "<" && !/[<>&]/.test(word.raw.slice(1));
}

function gitReadOnly(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (!GIT_GLOBAL.has(args[i]!)) return false;
    i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined || args.some((a) => hasLong(a, GIT_FORBIDDEN_LONG))) return false;
  // `git grep -O<cmd>` opens the matches with a command of the caller's choosing.
  if (sub === "grep") return !rest.some((a) => hasShort(a, "O") || hasLong(a, ["--open-files-in-pager*"]));
  if (GIT_SUBCOMMANDS.has(sub)) return true;
  switch (sub) {
    case "branch":
      return rest.every((a) => GIT_BRANCH_ARGS.has(a));
    case "remote":
      return rest.length === 0 || (rest.length === 1 && rest[0] === "-v");
    case "tag":
      return rest.length === 0 || (rest.length === 1 && (rest[0] === "-l" || rest[0] === "--list"));
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "reflog":
      return rest.length === 0 || rest[0] === "show";
    case "worktree":
      return rest[0] === "list";
    default:
      return false;
  }
}

/** Operands of `uniq`: a second one is the output file. `-` (stdin) and everything after `--` count. */
function uniqOperands(args: readonly string[]): number {
  const end = args.indexOf("--");
  const before = end === -1 ? args : args.slice(0, end);
  const after = end === -1 ? [] : args.slice(end + 1);
  return before.filter((a) => a === "-" || !a.startsWith("-")).length + after.length;
}

/** Commands that are read-only unless given one of the options they can write or execute with. */
function optionsReadOnly(command: string, args: readonly string[]): boolean {
  switch (command) {
    case "find":
      return !args.some((a) => FIND_FORBIDDEN.has(a));
    case "fd":
      return !args.some((a) => hasShort(a, "xX") || hasLong(a, ["--exec*"]));
    case "rg":
      return !args.some((a) => hasLong(a, ["--pre", "--pre-glob"]));
    case "sort":
      return !args.some((a) => hasShort(a, "o") || hasLong(a, ["--output*", "--compress-program*"]));
    case "uniq":
      return uniqOperands(args) <= 1;
    case "tree":
      // `-R` reruns tree with `-o 00Tree.html` in every directory.
      return !args.some((a) => hasShort(a, "oR") || hasLong(a, ["--output*"]));
    case "date":
      // An operand other than `+FORMAT` sets the clock (POSIX and BSD `date MMDDhhmm`).
      return !args.some((a) => hasShort(a, "s") || hasLong(a, ["--set*"]) || (!a.startsWith("-") && !a.startsWith("+")));
    case "file":
      // `-C` compiles a magic file and writes `<name>.mgc`.
      return !args.some((a) => hasShort(a, "C") || hasLong(a, ["--compile"]));
    case "git":
      return gitReadOnly(args);
    default:
      return false;
  }
}

function isReadOnlyPart(part: string): boolean {
  if (hasLeadingPrefix(part)) return false;
  const words = splitWords(part);
  const command = words[0];
  if (!command || command.redirect || command.raw.includes("/") || isCodeRunner(command.raw)) return false;
  if (words.some((w) => /[$`]/.test(w.raw))) return false;
  const args: Word[] = [];
  for (const word of words.slice(1)) {
    if (!word.redirect) args.push(word);
    else if (!acceptedRedirect(word)) return false;
  }
  if (PLAIN.has(command.raw)) return true;
  // A glob or brace can expand into a word that reads as an option (a file named `--output=x`).
  if (args.some((w) => w.glob)) return false;
  return optionsReadOnly(command.raw, args.map((w) => w.text));
}

/**
 * True when the command can only read: the parser models every part (no substitution, unsafe
 * redirect, heredoc or dynamic command word), and every part is an allowlisted command whose
 * arguments cannot make it write or run other code. Paths are checked by pathsStayInside.
 */
export function isReadOnlyCommand(command: string): boolean {
  const { parts, unsafe } = splitBashCommand(command);
  return !unsafe && parts.length > 0 && parts.every(isReadOnlyPart);
}

/**
 * The strings in a word that the program may treat as a path: the word, the value of
 * `--opt=value`, and the attached value of a short option (`-f/etc/x`).
 */
function pathCandidates(text: string): string[] {
  const out = [text];
  const eq = text.indexOf("=");
  if (eq !== -1) out.push(text.slice(eq + 1));
  if (text.startsWith("-")) {
    const name = eq === -1 ? text : text.slice(0, eq);
    const at = name.search(/[/~]/);
    if (at > 0) out.push(name.slice(at));
  }
  return out;
}

function candidateInside(c: string, dirs: readonly string[], home: string, inside: (p: string) => boolean): boolean {
  if (c === "/dev/null") return true;
  if (c.startsWith("~")) {
    // `~user`, `~+`, `~-` and zsh named directories name places we cannot resolve.
    if (c !== "~" && !c.startsWith("~/")) return false;
    return inside(resolve(expandHome(c, home)));
  }
  if (c.startsWith("/")) return inside(resolve(c));
  if (c.split("/").includes("..")) return dirs.every((d) => inside(resolve(d, c)));
  return true;
}

function wordStaysInside(word: Word, dirs: readonly string[], home: string, inside: (p: string) => boolean): boolean {
  // Expansions we do not model: variables, brace lists (`{/etc,x}`), zsh `=cmd`.
  if (/[$`]/.test(word.raw) || word.brace || word.raw.startsWith("=")) return false;
  // A glob segment that starts with `.` or `[` can match `..` (bash before 5.2 lets `.*` and `.?` do so).
  if (word.glob && word.text.split("/").some((seg) => /[*?[]/.test(seg) && /^[.[]/.test(seg))) return false;
  let text = word.text;
  if (word.redirect) {
    const match = /^(?:\d*|&)(?:>>?|<)(.*)$/s.exec(text);
    if (!match) return false;
    text = match[1]!;
    // A bare operator's target is the next word, checked on its own; `>&2` duplicates a descriptor.
    if (text === "" || /^&(\d+|-)$/.test(text)) return true;
    if (/[<>&]/.test(text)) return false;
  }
  return pathCandidates(text).every((c) => candidateInside(c, dirs, home, inside));
}

/** The directory a `cd` part moves to, or undefined when it may leave the project (`cd`, `cd -`, zsh `cd old new`, `cd +1`). */
function cdTarget(words: readonly Word[]): string | undefined {
  const args = words.slice(1).filter((w) => !w.redirect);
  if (args.length !== 1) return undefined;
  const target = args[0]!.text;
  return target === "" || target.startsWith("-") || target.startsWith("+") ? undefined : target;
}

/**
 * True when every path the command names stays inside `allowedDirs`: each word that starts with
 * `/` or `~` or has a `..` segment (also as an option's value or a redirect target), after
 * unquoting, `~` expansion against `home` and resolution against `cwd`. `/dev/null` is exempt.
 * Anything it cannot resolve (variables, brace lists, `~user`, a `cd` that may go home) counts
 * as outside. Resolution is lexical: symlinks are left to the confinement profile.
 */
export function pathsStayInside(command: string, cwd: string, home: string, allowedDirs: string[]): boolean {
  const { parts, unsafe } = splitBashCommand(command);
  if (unsafe) return false;
  const inside = (p: string): boolean => allowedDirs.some((dir) => isInside(p, dir));
  // Relative words are trusted to stay under the working directory, so it must be inside itself.
  if (!inside(resolve(cwd))) return false;
  // A cd may fail (after `;` or `||`), so later words are checked from every directory the shell can be in.
  let dirs = [resolve(cwd)];
  for (const part of parts) {
    const words = splitWords(part);
    if (!words.every((w) => wordStaysInside(w, dirs, home, inside))) return false;
    if (words[0]?.raw !== "cd") continue;
    const target = cdTarget(words);
    if (target === undefined) return false;
    const next = dirs.map((d) => resolve(d, target));
    dirs = [...new Set([...dirs, ...next])];
  }
  return true;
}
