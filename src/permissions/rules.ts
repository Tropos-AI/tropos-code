// src/permissions/rules.ts
import { isAbsolute, join, sep } from "node:path";
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

/** Returns the target of the redirection whose `>` is at index `i`, e.g. "&1", "/dev/null", "out.txt". */
function redirectTarget(command: string, i: number): string {
  let j = i + 1;
  if (command[j] === ">") j++;
  if (command[j] === "&") {
    let fd = "&";
    j++;
    while (j < command.length && /[0-9-]/.test(command[j]!)) fd += command[j++];
    return fd;
  }
  while (command[j] === " " || command[j] === "\t") j++;
  let target = "";
  while (j < command.length && !/[\s;|&]/.test(command[j]!)) target += command[j++];
  return target;
}

function isSafeRedirect(target: string): boolean {
  return /^&[0-9-]+$/.test(target) || target === "/dev/null";
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
    if (ch === ">" && !isSafeRedirect(redirectTarget(command, i))) unsafe = true;
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

export function pathPatternMatches(pattern: string, absPath: string, cwd: string, home: string): boolean {
  const expanded = expandHome(pattern.trim(), home);
  const absPattern = isAbsolute(expanded) ? expanded : join(cwd, expanded);
  if (!GLOB_CHARS.test(absPattern)) {
    return absPath === absPattern || absPath.startsWith(absPattern.endsWith(sep) ? absPattern : absPattern + sep);
  }
  return new Bun.Glob(absPattern).match(absPath);
}
