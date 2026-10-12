// src/permissions/rules.ts
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { expandHome } from "../paths";

export interface Rule {
  tool: string;
  pattern?: string;
}

const RULE_RE = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/s;

export function parseRule(text: string): Rule {
  const match = RULE_RE.exec(text.trim());
  if (!match) throw new Error(`Invalid permission rule: "${text}"`);
  const pattern = match[2]?.trim();
  return pattern ? { tool: match[1]!, pattern } : { tool: match[1]! };
}

export function formatRule(rule: Rule): string {
  return rule.pattern ? `${rule.tool}(${rule.pattern})` : rule.tool;
}

export interface SplitCommand {
  parts: string[];
  unsafe: boolean;
}

/**
 * True when the redirection whose `>` is at index `i` only touches a file descriptor
 * (`>&N`, `>&-`) or /dev/null. A `>&WORD` redirect reads the whole word up to whitespace
 * or a control operator, so `>&2/../x` is not mistaken for `>&2`.
 */
function isSafeRedirect(command: string, i: number): boolean {
  let j = i + 1;
  const append = command[j] === ">";
  if (append) j++;
  if (command[j] === "&" && !append) {
    return /^(\d+|-)$/.test(readRedirectWord(command, j + 1));
  }
  while (command[j] === " " || command[j] === "\t") j++;
  return readRedirectWord(command, j) === "/dev/null";
}

/** Reads the redirect target word starting at `j`: everything up to whitespace or a control operator. */
function readRedirectWord(command: string, j: number): string {
  let word = "";
  while (j < command.length && !/[\s;|&]/.test(command[j]!)) word += command[j++];
  return word;
}

/**
 * End index (exclusive) of the shell word starting at `start`: stops at unquoted whitespace,
 * and treats quoted spans and backslash escapes as part of the word.
 */
function wordEnd(text: string, start: number): number {
  let i = start;
  let quote: "'" | '"' | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (quote === '"') {
      if (ch === "\\") i++;
      else if (ch === '"') quote = null;
    } else if (ch === "\\") i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (/\s/.test(ch)) break;
    i++;
  }
  return Math.min(i, text.length);
}

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * Splits a shell command into its simple commands (on && || ; | & and newlines),
 * respecting quotes, and flags constructs that rule matching cannot reason about.
 */
export function splitBashCommand(command: string): SplitCommand {
  const parts: string[] = [];
  let current = "";
  let unsafe = false;
  let quote: "'" | '"' | null = null;
  // True when the previous character was an unquoted, unescaped `>` (a redirect operator).
  let afterRedirect = false;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    const prevWasRedirect = afterRedirect;
    afterRedirect = false;

    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        if (next === "\n") unsafe = true;
        current += ch + (next ?? "");
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && next === "(")) unsafe = true;
      current += ch;
      continue;
    }

    if (ch === "\\") {
      if (next === "\n") unsafe = true; // line continuation joins words invisibly
      current += ch + (next ?? "");
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(") || ((ch === "<" || ch === ">") && next === "(")) {
      unsafe = true;
      current += ch;
      continue;
    }
    // ANSI-C ($'...') and locale ($"...") quoting: bash decodes escapes we do not model.
    if (ch === "$" && (next === "'" || next === '"')) {
      unsafe = true;
      current += ch;
      continue;
    }
    // Heredocs and herestrings (`<<`, `<<-`, `<<<`): the body is raw text that the shell
    // delimits itself, so quotes inside it would desync this scanner.
    if (ch === "<" && next === "<") {
      unsafe = true;
      current += ch;
      continue;
    }
    // `<&N` / `<&-` duplicate a file descriptor (like `>&`); it is not a background operator.
    if (ch === "<" && next === "&") {
      if (!/^(\d+|-)$/.test(readRedirectWord(command, i + 2))) unsafe = true;
      current += "<&";
      i++;
      continue;
    }
    // Any unquoted parenthesis: subshells, zsh =(cmd) and glob qualifiers.
    if (ch === "(" || ch === ")") {
      unsafe = true;
      current += ch;
      continue;
    }
    // A `#` starting a word is a comment in the shell, so later text may run unseen.
    if (ch === "#" && (i === 0 || /[\s;|&(]/.test(command[i - 1]!))) {
      unsafe = true;
      current += ch;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      push();
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|") {
      push();
      continue;
    }
    if (ch === "&") {
      if (next === ">" || prevWasRedirect) {
        current += ch; // `&>file` or the `&` of `2>&1`
        continue;
      }
      push(); // background operator
      continue;
    }
    if (ch === ">") {
      if (!isSafeRedirect(command, i)) unsafe = true;
      afterRedirect = true;
    }
    current += ch;
  }

  if (quote) unsafe = true;
  push();
  // A command word built from a variable or an escape is resolved by the shell, not by us.
  if (parts.some(hasDynamicCommandWord)) unsafe = true;
  return { parts, unsafe };
}

/** True when the first word after leading `NAME=value` assignments contains `$` or a backslash. */
function hasDynamicCommandWord(part: string): boolean {
  let i = 0;
  for (;;) {
    while (i < part.length && /\s/.test(part[i]!)) i++;
    const end = wordEnd(part, i);
    if (end === i) return false;
    const word = part.slice(i, end);
    if (ASSIGNMENT_WORD.test(word)) {
      i = end;
      continue;
    }
    return /[$\\]/.test(word);
  }
}

const COMMAND_WRAPPERS = new Set(["command", "builtin", "exec", "noglob", "nohup", "time", "-"]);
/** `env` options that take a separate argument word. */
const ENV_ARG_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir"]);

/**
 * Strips, from the front, the words that run a command without changing which command it
 * is: variable assignments, wrappers like `command` / `exec` / `nohup`, and `env` with its
 * options. Used so deny/ask rules still see `rm` in `FOO=1 env -i rm x`.
 */
function stripCommandWrappers(command: string): string {
  let i = 0;
  let inEnv = false;
  for (;;) {
    while (i < command.length && /\s/.test(command[i]!)) i++;
    const end = wordEnd(command, i);
    if (end === i) return command.slice(i);
    const word = command.slice(i, end);
    if (ASSIGNMENT_WORD.test(word) || COMMAND_WRAPPERS.has(word)) {
      i = end;
    } else if (word === "env") {
      inEnv = true;
      i = end;
    } else if (inEnv && word.startsWith("-")) {
      i = end;
      if (ENV_ARG_OPTIONS.has(word)) {
        while (i < command.length && /\s/.test(command[i]!)) i++;
        i = wordEnd(command, i);
      }
    } else {
      return command.slice(i);
    }
  }
}

export interface BashPatternOptions {
  /** True for deny/ask rules: broaden matching so wrappers cannot hide the command. */
  restrict?: boolean;
}

function bashPatternMatchesExact(pattern: string, command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  const p = pattern.trim();
  if (p === "*") return true;
  if (p.endsWith(":*")) {
    const prefix = p.slice(0, -2).trim().replace(/\s+/g, " ");
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  }
  return normalized === p.replace(/\s+/g, " ");
}

/**
 * Whether a single simple command matches a Bash rule pattern. Allow rules (default) match
 * the command as written. With `restrict` (deny/ask rules) leading assignments and wrapper
 * words are also stripped, and the rule matches if either form matches.
 */
export function bashPatternMatches(pattern: string, command: string, opts: BashPatternOptions = {}): boolean {
  if (bashPatternMatchesExact(pattern, command)) return true;
  return opts.restrict === true && bashPatternMatchesExact(pattern, stripCommandWrappers(command));
}

const GLOB_CHARS = /[*?[\]{}]/;

export interface PathPatternOptions {
  /**
   * True for deny/ask rules: broaden matching. Case is folded on case-insensitive platforms
   * (darwin, win32) and relative patterns that climb out of cwd may match outside it.
   * Allow rules (default) match exact case and only inside cwd.
   */
  restrict?: boolean;
}

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/** Glob matching uses "/" separators; Windows paths are converted before matching. */
const toGlobSep = (s: string): string => (sep === "\\" ? s.replace(/\\/g, "/") : s);

/**
 * Whether `absPath` is covered by a path rule pattern. The pattern is home-expanded and
 * resolved against `cwd`; `absPath` is resolved first so `..` segments cannot escape it.
 * For allow rules a relative pattern only ever matches paths inside `cwd`; with
 * `restrict` (deny/ask) it may match outside, and case is folded on darwin/win32 (pattern,
 * path and cwd alike). A pattern with no glob characters covers the path itself and
 * everything below it.
 */
export function pathPatternMatches(
  pattern: string,
  absPath: string,
  cwd: string,
  home: string,
  opts: PathPatternOptions = {},
): boolean {
  const restrict = opts.restrict === true;
  const fold = (s: string): string => (restrict && CASE_INSENSITIVE_FS ? s.toLowerCase() : s);

  const target = fold(resolve(absPath));
  const expanded = fold(expandHome(pattern.trim(), home));
  const root = fold(resolve(cwd));

  if (!restrict && !isAbsolute(expanded)) {
    // Allow rules with relative patterns are scoped to cwd: anything outside it, or on
    // another drive, is out.
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return false;
  }

  if (!GLOB_CHARS.test(expanded)) {
    const base = resolve(root, expanded);
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
  }
  if (isAbsolute(expanded)) return new Bun.Glob(normalize(expanded)).match(target);

  // Relative glob: match against the path relative to cwd, so cwd never reaches the glob
  // (it may contain glob characters).
  return new Bun.Glob(toGlobSep(normalize(expanded))).match(toGlobSep(relative(root, target)));
}
