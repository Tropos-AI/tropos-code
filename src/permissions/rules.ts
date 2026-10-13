// src/permissions/rules.ts
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { expandHome } from "../paths";

/** True on platforms whose filesystems ignore case by default (darwin, win32). */
export const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/**
 * Folds a file or command name the way a case-insensitive filesystem compares names. APFS
 * applies full Unicode case folding, so `ſh` runs `sh`, `K` (Kelvin sign) is `k`, `ﬆ` is `st`
 * and `ẞ` is `ss`; lower-, upper- then lower-casing after NFC reproduces that (`ẞ` lower-cases
 * to `ß`, which only upper-casing expands). Elsewhere names are unchanged.
 */
export function foldName(name: string, insensitive: boolean = CASE_INSENSITIVE_FS): string {
  return insensitive ? name.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC") : name;
}

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

/** Longest redirect target compared (`/dev/null`, a descriptor number); longer ones are never safe. */
const REDIRECT_WORD_MAX = 16;

/**
 * Reads the redirect target word starting at `j`: everything up to whitespace or a control
 * operator, but at most REDIRECT_WORD_MAX + 1 characters, so a run of `>` stays linear.
 */
function readRedirectWord(command: string, j: number): string {
  let end = j;
  while (end < command.length && end - j <= REDIRECT_WORD_MAX && !/[\s;|&]/.test(command[end]!)) end++;
  return command.slice(j, end);
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
    // Only shell whitespace separates words: a trailing no-break space belongs to the last word.
    const trimmed = current.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
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
  // A command word built from a variable, quote, glob or reserved word is resolved by the shell, not by us.
  if (parts.some(hasUnmodelledCommandWord)) unsafe = true;
  return { parts, unsafe };
}

/** Characters that make a shell word something other than a literal string. */
const DYNAMIC_WORD = /['"$`\\*?[\]{}]/;

/** Like DYNAMIC_WORD for option words; a literal `{}` (xargs `-I{}`) is not expanded by the shell. */
const isDynamicOption = (word: string): boolean => DYNAMIC_WORD.test(word.replaceAll("{}", ""));

/** Shell reserved words: they change how the rest of the line is parsed, so rules cannot model them. */
const RESERVED_WORDS = new Set([
  "!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until",
  "for", "case", "esac", "function", "select", "coproc", "[[",
  // zsh loops: `repeat N cmd` and `foreach x (list) ...`.
  "repeat", "foreach",
]);

/**
 * Options of a wrapper command. `flags` and `args` list short option letters (args take a
 * value, attached or as the next word); `long` and `longArgs` list long options.
 */
interface WrapperSpec {
  flags?: string;
  args?: string;
  long?: readonly string[];
  longArgs?: readonly string[];
  /** A DURATION word follows the options (`timeout`). */
  duration?: boolean;
  /** Accepts the legacy `-N` form (`nice -10`). */
  numeric?: boolean;
}

const WRAPPERS = new Map<string, WrapperSpec>([
  ["command", { flags: "p" }],
  ["builtin", {}],
  ["exec", { flags: "cl", args: "a" }],
  ["noglob", {}],
  ["nocorrect", {}],
  ["nohup", {}],
  ["time", { flags: "p" }],
  ["-", {}],
  // `-S` / `--split-string` are deliberately absent: they run a string we cannot see.
  ["env", { flags: "i0v", args: "uC", long: ["--ignore-environment", "--null"], longArgs: ["--unset", "--chdir"] }],
  [
    "sudo",
    {
      flags: "AbEHknPSB",
      args: "ugCpDrtTU",
      long: ["--non-interactive", "--stdin", "--set-home", "--preserve-env", "--background"],
      longArgs: ["--user", "--group", "--chdir", "--prompt", "--role", "--type"],
    },
  ],
  ["doas", { flags: "n", args: "uC" }],
  [
    "xargs",
    {
      flags: "0prtxoV",
      args: "InPLsdEaJ",
      long: ["--null", "--no-run-if-empty", "--verbose", "--interactive", "--exit", "--open-tty"],
      longArgs: ["--max-args", "--max-procs", "--max-lines", "--max-chars", "--delimiter", "--arg-file", "--eof"],
    },
  ],
  [
    "timeout",
    { flags: "v", args: "ks", long: ["--foreground", "--preserve-status", "--verbose"], longArgs: ["--kill-after", "--signal"], duration: true },
  ],
  ["nice", { args: "n", longArgs: ["--adjustment"], numeric: true }],
  ["ionice", { flags: "t", args: "cn", long: ["--ignore"], longArgs: ["--class", "--classdata"] }],
  ["stdbuf", { args: "ioe", longArgs: ["--input", "--output", "--error"] }],
  ["setsid", { flags: "cfw", long: ["--ctty", "--fork", "--wait"] }],
  ["caffeinate", { flags: "dimsu", args: "tw" }],
  ["unbuffer", {}],
]);

interface StrippedCommand {
  /** The command with leading assignments and wrappers removed (starts at the command word). */
  rest: string;
  /** A wrapper had an option, or an option value, that this code does not model. */
  unmodelled: boolean;
}

/**
 * Consumes the options of one wrapper starting at `start`. Returns the index after them, or
 * `ok: false` (with the index of the offending word) when an option is not modelled.
 */
function skipWrapperOptions(command: string, start: number, spec: WrapperSpec): { i: number; ok: boolean } {
  let i = start;
  const nextWord = (from: number): { word: string; at: number; end: number } => {
    let at = from;
    while (at < command.length && /\s/.test(command[at]!)) at++;
    const end = wordEnd(command, at);
    return { word: command.slice(at, end), at, end };
  };
  for (;;) {
    const { word, at, end } = nextWord(i);
    if (word.length < 2 || word[0] !== "-") return { i: at, ok: true }; // not an option: the command follows
    i = end;
    if (word === "--") return { i, ok: true };
    if (isDynamicOption(word)) return { i: at, ok: false };
    if (spec.numeric && /^-\d+$/.test(word)) continue;

    const takeValue = (): boolean => {
      const value = nextWord(i);
      if (!value.word || isDynamicOption(value.word)) return false;
      i = value.end;
      return true;
    };

    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq === -1 ? word : word.slice(0, eq);
      if (eq === -1 && spec.long?.includes(name)) continue;
      if (spec.longArgs?.includes(name)) {
        if (eq === -1 && !takeValue()) return { i: at, ok: false };
        continue;
      }
      return { i: at, ok: false };
    }

    for (let k = 1; k < word.length; k++) {
      const c = word[k]!;
      if (spec.flags?.includes(c)) continue;
      if (spec.args?.includes(c)) {
        if (k === word.length - 1 && !takeValue()) return { i: at, ok: false };
        break; // an attached value uses the rest of the word
      }
      return { i: at, ok: false };
    }
  }
}

const LEADING_REDIRECT = /^(?:\d*|&)(>>?|<)(.*)$/s;

/**
 * Classifies a word at the front of a command as a redirect: "safe" (only an fd or /dev/null),
 * "target" (a bare operator whose target is the next word), "unsafe" (any other redirect), or
 * undefined when the word is not a redirect at all.
 */
function leadingRedirect(word: string): "safe" | "target" | "unsafe" | undefined {
  const match = LEADING_REDIRECT.exec(word);
  if (!match) return undefined;
  const target = match[2]!;
  if (target === "") return "target";
  if (target === "/dev/null") return "safe";
  if (target.startsWith("&") && !word.includes(">>") && /^(\d+|-)$/.test(target.slice(1))) return "safe";
  return "unsafe";
}

/** The final path component of a command word (`/usr/bin/sudo` -> `sudo`). */
const baseName = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

/**
 * Strips, from the front, the words that run a command without changing which command it
 * is: variable assignments, safe redirects (`2>&1`, `>/dev/null`) and known wrappers
 * (`command`, `sudo`, `env`, `timeout` ...) with their options, however they are path-qualified.
 * At most `maxWrappers` wrapper words are stripped (0 strips only assignments and redirects).
 * A wrapper option or redirect that is not modelled sets `unmodelled` (never guess).
 */
function stripWrappers(command: string, maxWrappers = Number.POSITIVE_INFINITY): StrippedCommand {
  let i = 0;
  let wrappers = 0;
  for (;;) {
    while (i < command.length && /\s/.test(command[i]!)) i++;
    const end = wordEnd(command, i);
    if (end === i) return { rest: "", unmodelled: false };
    const word = command.slice(i, end);
    if (ASSIGNMENT_WORD.test(word)) {
      i = end;
      continue;
    }
    const redirect = leadingRedirect(word);
    if (redirect === "safe") {
      i = end;
      continue;
    }
    if (redirect === "target") {
      let at = end;
      while (at < command.length && /\s/.test(command[at]!)) at++;
      const targetEnd = wordEnd(command, at);
      if (command.slice(at, targetEnd) !== "/dev/null") return { rest: command.slice(i), unmodelled: true };
      i = targetEnd;
      continue;
    }
    if (redirect === "unsafe") return { rest: command.slice(i), unmodelled: true };
    if (wrappers >= maxWrappers) return { rest: command.slice(i), unmodelled: false };
    const spec = WRAPPERS.get(foldName(word)) ?? (word.includes("/") ? WRAPPERS.get(foldName(baseName(word))) : undefined);
    if (!spec) return { rest: command.slice(i), unmodelled: false };

    wrappers++;
    const opts = skipWrapperOptions(command, end, spec);
    i = opts.i;
    if (!opts.ok) return { rest: command.slice(i), unmodelled: true };
    if (spec.duration) {
      while (i < command.length && /\s/.test(command[i]!)) i++;
      const durationEnd = wordEnd(command, i);
      if (!/^\d+(\.\d+)?[smhd]?$/.test(command.slice(i, durationEnd))) {
        return { rest: command.slice(i), unmodelled: true };
      }
      i = durationEnd;
    }
  }
}

/** Removes quotes and backslash escapes from a single shell word. */
function unquoteWord(word: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else out += ch;
    } else if (ch === "\\" && i + 1 < word.length) {
      out += word[++i];
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else out += ch;
    } else if (ch === "'" || ch === '"') quote = ch;
    else out += ch;
  }
  return out;
}

/** Commands that run text we cannot see: `eval`, `source`, `.`, `trap` and zsh `emulate -c`. */
const EVAL_WORDS = new Set(["eval", "source", ".", "trap", "emulate"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** True when a shell invocation passes a command string (`-c`, `-lc`, `-c'cmd'`, fish `--command`). */
function runsShellString(rest: string): boolean {
  let i = wordEnd(rest, 0);
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i]!)) i++;
    const end = wordEnd(rest, i);
    const word = unquoteWord(rest.slice(i, end));
    if (/^-[A-Za-z]*c/.test(word) || word === "--command" || word.startsWith("--command=")) return true;
    i = end;
  }
  return false;
}

/** True when the command word left after assignments and wrappers is not a plain literal. */
function hasUnmodelledCommandWord(part: string): boolean {
  const { rest, unmodelled } = stripWrappers(part);
  if (unmodelled) return true;
  const word = rest.slice(0, wordEnd(rest, 0));
  if (!word) return false;
  if (RESERVED_WORDS.has(word) || DYNAMIC_WORD.test(word) || word.startsWith("=")) return true;
  if (EVAL_WORDS.has(foldName(word))) return true;
  return SHELLS.has(foldName(baseName(word))) && runsShellString(rest);
}

/**
 * Spells a command's word canonically for deny/ask matching: past leading assignments and
 * redirects, without quotes (`"rm" x`, `r''m x`), as its basename (`/bin/rm`) and folded the
 * way the filesystem compares names (`RM`, `ſudo`).
 */
function canonicalCommandWord(command: string): string {
  const { rest } = stripWrappers(command, 0);
  const end = wordEnd(rest, 0);
  let word = unquoteWord(rest.slice(0, end));
  // A path-qualified command word (`/bin/rm`, `./rm`) names the same command as its basename.
  if (word.includes("/") && baseName(word) !== "") word = baseName(word);
  return foldName(word) + rest.slice(end);
}

/**
 * Every form a deny/ask rule is checked against: the canonical spelling of the command, then
 * of what is left each time leading wrappers are stripped (`/usr/bin/ſudo rm x` gives
 * `sudo rm x` and `rm x`), so rules for wrappers and for wrapped commands both match.
 */
function restrictForms(command: string, budget: Budget): string[] {
  const forms: string[] = [];
  let current = command;
  // Each pass strips at least one wrapper word, so the command's length bounds the passes;
  // the bound only guards against a loop, it never cuts a real chain of wrappers short.
  for (let n = 0; n <= command.length; n++) {
    spend(budget, 3 * current.length);
    const canonical = canonicalCommandWord(current);
    forms.push(canonical);
    const { rest } = stripWrappers(canonical, 1);
    if (rest === canonical || rest === "") return forms;
    // The wrapper with its options dropped, before the canonical inner command (`sudo rm x`).
    forms.push(`${canonical.slice(0, wordEnd(canonical, 0))} ${canonicalCommandWord(rest)}`);
    current = rest;
  }
  return forms;
}

/**
 * Command words that run other code: shells, interpreters, package runners and wrappers.
 * A prefix or wildcard allow rule never approves them (only an exact rule can); deny/ask
 * matching is unaffected.
 */
export const CODE_RUNNERS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "source", ".",
  "python", "python3", "node", "deno", "perl", "ruby", "php", "npx", "bunx", "pnpx", "uvx",
  "sudo", "doas", "env", "timeout", "nohup", "nice", "ionice", "stdbuf", "setsid", "caffeinate",
  "unbuffer", "command", "builtin", "exec", "xargs", "time", "noglob", "nocorrect",
  "awk", "gawk", "mawk", "nawk", "python2", "pypy", "pypy3", "ipython", "pwsh", "powershell",
  "osascript", "lua", "luajit", "tclsh", "wish", "Rscript", "irb", "jshell", "expect", "ssh",
  "script", "nodejs", "tsx", "ts-node", "trap", "emulate",
  // Every wrapper runs the command after it (zsh's `-` among them).
  ...WRAPPERS.keys(),
]);

const CODE_RUNNERS_FOLDED: ReadonlySet<string> = new Set([...CODE_RUNNERS].map((w) => foldName(w, true)));

/**
 * Whether a command word names a code runner: compared by basename, ignoring a trailing
 * version suffix (`python3.12`, `node22`) and, on case-insensitive platforms, case.
 */
export function isCodeRunner(word: string): boolean {
  const base = baseName(word);
  const known = (w: string): boolean =>
    CODE_RUNNERS.has(w) || (CASE_INSENSITIVE_FS && CODE_RUNNERS_FOLDED.has(foldName(w)));
  return known(base) || known(base.replace(/[0-9][0-9.]*$/, ""));
}

/** True when the simple command begins (after assignments and safe redirects) with a code runner. */
function startsWithCodeRunner(command: string): boolean {
  const { rest } = stripWrappers(command, 0);
  const word = rest.slice(0, wordEnd(rest, 0));
  return isCodeRunner(word);
}

/** True when assignments, safe redirects or wrapper words lead the simple command. */
export function hasLeadingPrefix(part: string): boolean {
  return stripWrappers(part).rest !== part.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
}

export interface BashPatternOptions {
  /** True for deny/ask rules: broaden matching so wrappers cannot hide the command. */
  restrict?: boolean;
  /** Work allowance for restrict matching, shared across the rules checked for one request. */
  budget?: RestrictBudget;
}

/**
 * Collapses runs of unquoted shell whitespace (space, tab, newline) to one space and trims them.
 * Whitespace inside quotes or after a backslash is part of a word and kept as written, and
 * Unicode spaces are ordinary characters to the shell.
 */
export function squashShellSpace(s: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let space = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote === null && (ch === " " || ch === "\t" || ch === "\n")) {
      space = out !== "";
      continue;
    }
    if (space) out += " ";
    space = false;
    out += ch;
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === "\\" && i + 1 < s.length) {
      out += s[++i];
    } else if (quote === '"') {
      if (ch === '"') quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    }
  }
  return out;
}

/** Collapses every run of shell whitespace, quoted or not: deny/ask rules match broadly. */
const squashAllShellSpace = (s: string): string => s.replace(/^[ \t\n]+|[ \t\n]+$/g, "").replace(/[ \t\n]+/g, " ");

function bashPatternMatchesExact(pattern: string, command: string, restrict = false): boolean {
  const squash = restrict ? squashAllShellSpace : squashShellSpace;
  const normalized = squash(command);
  const p = pattern.trim();
  if (p === "*") return true;
  if (p.endsWith(":*")) {
    const prefix = squash(p.slice(0, -2));
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  }
  return normalized === squash(p);
}

/**
 * Whether a single simple command matches a Bash rule pattern. Allow rules (default) match
 * the command as written. With `restrict` (deny/ask rules) leading assignments and wrapper
 * words are also stripped, and the rule matches if either form matches.
 */
export function bashPatternMatches(pattern: string, command: string, opts: BashPatternOptions = {}): boolean {
  const p = pattern.trim();
  const broad = p === "*" || p.endsWith(":*");
  if (broad && opts.restrict !== true && startsWithCodeRunner(command)) return false;
  if (opts.restrict !== true) return bashPatternMatchesExact(pattern, command);
  if (bashPatternMatchesExact(pattern, command, true)) return true;
  const folded = foldRuleWords(pattern);
  const hit = (form: string): boolean => bashPatternMatchesExact(folded, form, true);
  const budget = opts.budget ?? createRestrictBudget();
  try {
    if (restrictForms(command, budget).some(hit)) return true;
    // An unsafe command may run the denied one anywhere inside it: `(rm x)`, `$(rm x)`, `>f rm x`.
    return splitBashCommand(command).unsafe && embeddedForms(command, folded, budget).some(hit);
  } catch (err) {
    // A command too convoluted to analyse within the budget matches: deny/ask fail closed.
    if (err instanceof BudgetExceeded) return true;
    throw err;
  }
}

/**
 * Characters the deny/ask matching for one request may scan. Matching re-reads the command once per wrapper
 * and per embedded candidate, so a pathological command (thousands of nested wrappers) could
 * otherwise take minutes; everyday commands use a tiny fraction of this.
 */
export const RESTRICT_BUDGET = 4_000_000;

export interface RestrictBudget {
  left: number;
}

type Budget = RestrictBudget;

/** A fresh allowance of RESTRICT_BUDGET characters for one request's deny/ask matching. */
export function createRestrictBudget(): RestrictBudget {
  return { left: RESTRICT_BUDGET };
}

class BudgetExceeded extends Error {}

function spend(budget: Budget, chars: number): void {
  budget.left -= chars;
  if (budget.left < 0) throw new BudgetExceeded();
}

/** Characters after which a word may be a command when the shell parses an unsafe command. */
const COMMAND_BOUNDARY = /[\s(){};!|&`'"<>$=]/;
/** Characters that end an embedded command's text. */
const EMBEDDED_END = /[)};|&`<>\n]/;
const EMBEDDED_END_FROM = /[)};|&`<>\n]/g;

/**
 * Deny/ask forms for an unsafe command: every word that follows a boundary character and names
 * the rule's command (canonically spelled) starts a form, cut where its simple command ends.
 * This over-matches on purpose: unsafe commands are never auto-approved, so the only cost of
 * a false hit is a deny where an ask would do.
 */
function embeddedForms(command: string, foldedPattern: string, budget: Budget): string[] {
  const ruleWord = foldedPattern.split(/[ \t\n]+/)[0]!.replace(/:\*$/, "");
  if (ruleWord === "" || ruleWord === "*") return [];
  const text = command.replace(/\\\n/g, "");
  const forms: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && !COMMAND_BOUNDARY.test(text[i - 1]!)) continue;
    if (/\s/.test(text[i]!)) continue;
    const end = wordEnd(text, i);
    spend(budget, end - i + 1);
    let word = unquoteWord(text.slice(i, end).split(EMBEDDED_END)[0]!);
    if (word.includes("/") && baseName(word) !== "") word = baseName(word);
    if (foldName(word) !== ruleWord) continue;
    EMBEDDED_END_FROM.lastIndex = i;
    const stop = EMBEDDED_END_FROM.exec(text)?.index ?? text.length;
    spend(budget, stop - i + 1);
    let tail = text.slice(i, stop);
    // Text that began right after a quote ends at the matching quote.
    const opener = text[i - 1];
    if (opener === "'" || opener === '"') tail = tail.split(opener)[0]!;
    for (const form of restrictForms(tail, budget)) forms.push(form);
  }
  return forms;
}

/**
 * Folds a rule's command word on case-insensitive platforms, to meet the folded command word,
 * and for a rule naming wrappers (`sudo rm:*`) each wrapper and the command after them.
 */
function foldRuleWords(pattern: string): string {
  if (!CASE_INSENSITIVE_FS) return pattern;
  const words = pattern.trim().split(/[ \t\n]+/);
  for (let k = 0; k < words.length; k++) {
    words[k] = foldName(words[k]!);
    if (!WRAPPERS.has(words[k]!.replace(/:\*$/, ""))) break;
  }
  return words.join(" ");
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
  const fold = (s: string): string => (restrict ? foldName(s) : s);

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
