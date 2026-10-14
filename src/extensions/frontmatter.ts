// src/extensions/frontmatter.ts

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Splits a markdown file into its YAML frontmatter and body. A file without frontmatter has empty
 * data. YAML that doesn't parse (unquoted globs, colons in descriptions) falls back to one
 * `key: value` per line, so a sloppy header still loads.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const source = text.replace(/^﻿/, "");
  const match = FENCE.exec(source);
  if (!match) return { data: {}, body: source };
  const body = source.slice(match[0].length);
  try {
    const parsed: unknown = Bun.YAML.parse(match[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { data: parsed as Record<string, unknown>, body };
    return { data: {}, body };
  } catch {
    return { data: lineData(match[1]!), body };
  }
}

function lineData(yaml: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) data[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return data;
}

/** A frontmatter value as a trimmed, non-empty string. */
export function fmString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A list value: a YAML list or a comma-separated string. Undefined when the key is absent. */
export function fmList(data: Record<string, unknown>, key: string): string[] | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return splitList(value);
  return undefined;
}

/** Splits "Read, Grep, Bash(git diff:*)" on commas outside parentheses. */
export function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function fmBool(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
