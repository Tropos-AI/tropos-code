// src/extensions/commands.ts
import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { neutraliseHarnessTags } from "../context/tags";
import { isAnthropicModelId } from "../config/settings";
import { errorText } from "../error-text";
import { fmString, parseFrontmatter } from "./frontmatter";
import { qualifiedName, staysInProject, type ExtensionDir, type ExtensionSource } from "./sources";

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  path: string;
  source: ExtensionSource;
  model?: string;
  agent?: string;
}

export interface CommandIO {
  /** Runs one `` !`cmd` `` through the Bash tool's permission check; a decline aborts the expansion. */
  runShell(command: string): Promise<{ ok: true; output: string } | { ok: false; reason: string }>;
  /** Resolves an `@path` token (without the "@"); null when it is not a readable, allowed file. */
  readFile(token: string): Promise<{ path: string; content: string } | null>;
}

/** Bytes read from one extension markdown file; extensions are prompt text, so more is a mistake. */
export const MAX_EXTENSION_BYTES = 200 * 1024;
/** Characters of `` !`cmd` `` output kept in an expanded command. */
export const MAX_SHELL_OUTPUT = 10_000;
const MAX_DESCRIPTION = 100;
/** Bounds the recursive walk: symlinked folders may loop, and a repo may hold a huge tree. */
const MAX_DEPTH = 6;
const MAX_FILES = 1000;

/** One name segment: what a file or folder may be called to become `/name`. */
export const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Escapes a value placed inside a double-quoted attribute of an XML-ish tag. */
export function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Reads at most `max` bytes of a regular file. O_NONBLOCK keeps a FIFO from blocking the open, and
 * fstat then rejects it. Throws on unreadable files; callers turn that into a warning.
 */
export async function readCapped(path: string, max = MAX_EXTENSION_BYTES): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    const want = Math.min(info.size, max);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await handle.read(buf, got, want - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return { text: buf.subarray(0, got).toString("utf8"), truncated: info.size > max };
  } finally {
    await handle.close();
  }
}

/**
 * Lists `<dir>/**\/*.md` as paths relative to `dir`, sorted, skipping dotfiles. A missing folder is
 * an empty list; anything else unreadable becomes a warning. Symlinks are followed, with the depth
 * and file caps standing in for loop detection.
 */
export async function listMarkdown(dir: string, warnings: string[]): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(current)).sort();
    } catch (err) {
      if (!isMissing(err)) warnings.push(`Cannot read ${current}: ${errorText(err)}`);
      return;
    }
    for (const name of names) {
      if (found.length >= MAX_FILES) return;
      if (name.startsWith(".")) continue;
      const full = join(current, name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue; // a dangling symlink
      }
      if (info.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (info.isFile() && name.endsWith(".md")) {
        found.push(relative(dir, full));
      }
    }
  }
  await walk(dir, 0);
  return found;
}

/** The first non-empty body line, without heading marks, capped: a description for files that give none. */
export function firstLine(body: string, max = MAX_DESCRIPTION): string {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Loads custom slash commands, highest-precedence folder first; the first definition of a name
 * wins. A subfolder becomes a ":" segment (`git/pr.md` is `/git:pr`). Built-ins are never
 * shadowed: a clash is skipped with a warning. A project command's non-Anthropic model is dropped,
 * since it would send the session (and the user's key) to a provider the repo chose.
 */
export async function loadCommands(dirs: ExtensionDir[], reserved: Set<string>): Promise<{ commands: CustomCommand[]; warnings: string[] }> {
  const warnings: string[] = [];
  const commands: CustomCommand[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const rel of await listMarkdown(dir.dir, warnings)) {
      const path = join(dir.dir, rel);
      const segments = rel.slice(0, -".md".length).split(sep);
      if (!segments.every((s) => NAME_SEGMENT.test(s))) {
        warnings.push(`Skipped command ${path}: names use letters, digits, ".", "_" and "-"`);
        continue;
      }
      const name = qualifiedName(dir, segments.join(":"));
      if (reserved.has(name)) {
        warnings.push(`Skipped command /${name} (${path}): a built-in command has that name`);
        continue;
      }
      if (seen.has(name)) continue;
      if (!(await staysInProject(dir, path))) {
        warnings.push(`Skipped command ${path}: it links outside the project`);
        continue;
      }
      let text: string;
      try {
        const read = await readCapped(path);
        if (read.truncated) warnings.push(`Command /${name} was cut to ${MAX_EXTENSION_BYTES / 1024} KB (${path})`);
        text = read.text;
      } catch (err) {
        warnings.push(`Cannot read command ${path}: ${errorText(err)}`);
        continue;
      }
      seen.add(name);
      const { data, body } = parseFrontmatter(text);
      let model = fmString(data, "model");
      if (model && dir.source === "project" && !isAnthropicModelId(model)) {
        warnings.push(`Command /${name} ignores model "${model}": a project command may only pick an Anthropic model`);
        model = undefined;
      }
      commands.push({
        name,
        description: fmString(data, "description") ?? firstLine(body),
        argumentHint: fmString(data, "argument-hint"),
        body,
        path,
        source: dir.source,
        model,
        agent: fmString(data, "agent"),
      });
    }
  }
  return { commands, warnings };
}

/**
 * Splits an argument string the way a POSIX shell would for simple words: whitespace separates,
 * single quotes are literal, double quotes allow \" \\ \$ and \`, and a backslash outside quotes
 * escapes the next character. An unterminated quote runs to the end.
 */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < input.length && '"\\$`'.includes(input[i + 1]!)) current += input[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\") {
      if (i + 1 < input.length) current += input[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) args.push(current);
      current = "";
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) args.push(current);
  return args;
}

/** `` !`cmd` `` or `@path`, each at the start of a line or after whitespace. */
const INLINE = /(?<=^|\s)(?:!`([^`\n]+)`|@(\S+))/gm;
const PLACEHOLDER = /\$ARGUMENTS|\$[1-9]/;

function capOutput(text: string): string {
  if (text.length <= MAX_SHELL_OUTPUT) return text;
  return `${text.slice(0, MAX_SHELL_OUTPUT)}\n[output truncated: ${text.length - MAX_SHELL_OUTPUT} more characters]`;
}

/** Quotes one word for a POSIX shell: everything literal inside single quotes. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * Expands a command body into the prompt text. The `` !`cmd` `` and `@path` tokens are found in the
 * body as written, before arguments go in, so text the user (or a script calling `tcode -p`) passes
 * as arguments can never become a shell command or a file to inline. Inside a shell command,
 * `$ARGUMENTS` and `$1`…`$9` are replaced with shell-quoted words. Neither shell output nor file
 * content is scanned again. Every shell command runs, in order, before any file is read; the first
 * decline aborts the whole expansion.
 */
export async function expandCommand(cmd: Pick<CustomCommand, "body">, args: string, io: CommandIO): Promise<{ ok: true; prompt: string } | { ok: false; reason: string }> {
  const raw = args.trim();
  const split = splitArgs(raw);
  const body = cmd.body;
  // One pass with a replacer function, so "$&" or "$1" inside the arguments stays literal.
  // Body text, arguments, shell output and file content are all untrusted: none may pose as a harness tag.
  const plain = (text: string) => neutraliseHarnessTags(substitute(text, (w) => w));
  const substitute = (text: string, quote: (word: string) => string) =>
    text.replace(/\$ARGUMENTS|\$([1-9])/g, (_, n: string | undefined) => quote(n === undefined ? raw : (split[Number(n) - 1] ?? "")));

  const matches = [...body.matchAll(INLINE)];
  const replacements = new Map<number, string>();
  for (const m of matches) {
    if (m[1] === undefined) continue;
    const result = await io.runShell(substitute(m[1], shellQuote));
    if (!result.ok) return { ok: false, reason: result.reason };
    replacements.set(m.index, neutraliseHarnessTags(capOutput(result.output)));
  }
  for (const m of matches) {
    if (m[2] === undefined) continue;
    const file = await io.readFile(substitute(m[2], (w) => w));
    if (file) replacements.set(m.index, `<file path="${escapeAttr(file.path)}">\n${neutraliseHarnessTags(file.content)}\n</file>`);
  }
  let out = "";
  let last = 0;
  for (const m of matches) {
    const replacement = replacements.get(m.index);
    if (replacement === undefined) continue;
    out += plain(body.slice(last, m.index)) + replacement;
    last = m.index + m[0].length;
  }
  out += plain(body.slice(last));
  if (!PLACEHOLDER.test(body) && raw) out = `${out.trimEnd()}\n\nArguments: ${neutraliseHarnessTags(raw)}`;
  return { ok: true, prompt: out.trim() };
}

/** What the model receives for a custom command; the transcript shows the typed `/name args` (also on resume, from these attributes). */
export function commandMessage(name: string, prompt: string, args = "", source: ExtensionSource = "user"): string {
  const argsAttr = args.trim() ? ` args="${escapeAttr(args.trim())}"` : "";
  return `<command name="/${escapeAttr(name)}"${argsAttr} source="${source}">\n${prompt}\n</command>`;
}
