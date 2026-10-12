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
    j++;
    let word = "";
    while (j < command.length && !/[\s;|&]/.test(command[j]!)) word += command[j++];
    return /^(\d+|-)$/.test(word);
  }
  while (command[j] === " " || command[j] === "\t") j++;
  let target = "";
  while (j < command.length && !/[\s;|&]/.test(command[j]!)) target += command[j++];
  return target === "/dev/null";
}

/**
 * Splits a shell command into its simple commands (on && || ; | & and newlines),
 * respecting quotes, and flags constructs that rule matching cannot reason about.
 */
export function splitBashCommand(command: string): SplitCommand {
  const parts: string[] = [];
  let current = "";
  let unsafe = false;
  let quote: "'" | '"' | null = null;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
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
      if (next === ">" || current.endsWith(">")) {
        current += ch; // `&>file` or the `&` of `2>&1`
        continue;
      }
      push(); // background operator
      continue;
    }
    if (ch === ">" && !isSafeRedirect(command, i)) unsafe = true;
    current += ch;
  }

  if (quote) unsafe = true;
  push();
  return { parts, unsafe };
}

export function bashPatternMatches(pattern: string, command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  const p = pattern.trim();
  if (p === "*") return true;
  if (p.endsWith(":*")) {
    const prefix = p.slice(0, -2).trim().replace(/\s+/g, " ");
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  }
  return normalized === p.replace(/\s+/g, " ");
}

const GLOB_CHARS = /[*?[\]{}]/;
// macOS and Windows filesystems are case-insensitive by default.
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

const fold = (s: string): string => (CASE_INSENSITIVE ? s.toLowerCase() : s);
/** Glob matching uses "/" separators; Windows paths are converted before matching. */
const toGlobSep = (s: string): string => (sep === "\\" ? s.replace(/\\/g, "/") : s);
const climbsUp = (p: string): boolean => p === ".." || p.startsWith("../");

function globMatch(pattern: string, subject: string): boolean {
  return new Bun.Glob(fold(pattern)).match(fold(subject));
}

/**
 * Whether `absPath` is covered by a path rule pattern. The pattern is home-expanded and
 * resolved against `cwd`; `absPath` is resolved first so `..` segments cannot escape it.
 * A pattern with no glob characters covers the path itself and everything below it.
 */
export function pathPatternMatches(pattern: string, absPath: string, cwd: string, home: string): boolean {
  const target = resolve(absPath);
  const expanded = expandHome(pattern.trim(), home);

  if (!GLOB_CHARS.test(expanded)) {
    const base = fold(resolve(cwd, expanded));
    const subject = fold(target);
    return subject === base || subject.startsWith(base.endsWith(sep) ? base : base + sep);
  }
  if (isAbsolute(expanded)) return globMatch(normalize(expanded), target);

  // Relative glob: match against the path relative to cwd, so cwd never reaches the glob
  // (it may contain glob characters). Paths outside cwd only match patterns that climb too.
  const globPattern = toGlobSep(normalize(expanded));
  const rel = toGlobSep(relative(resolve(cwd), target));
  if (climbsUp(rel) && !climbsUp(globPattern)) return false;
  return globMatch(globPattern, rel);
}
