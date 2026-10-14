// src/ui/tool-view.ts
import { isAbsolute, relative } from "node:path";
import { patchBody } from "../tools/diff";
import type { DiffDisplay, Todo, ToolOutput, ToolResultContent } from "../tools/types";
import { sanitizeForTerminal } from "./terminal-safe";
import type { TranscriptItem } from "./transcript";

/**
 * Everything a tool row shows, worked out from the transcript item alone. Keeping the per-tool rules
 * here (and out of the Ink components) makes them plain functions that tests can check line by line.
 * All text that came from the model or a tool is sanitized here, so the view is safe to print as is.
 */

/** Theme colors a result segment may use; the component maps them to the active theme. */
export type ColorKey = "text" | "muted" | "subtle" | "accent" | "success" | "danger" | "warning";

export interface Segment {
  text: string;
  color?: ColorKey;
  bold?: boolean;
}

export type Line = Segment[];

export type ResultView =
  | { kind: "none" }
  | { kind: "lines"; lines: Line[] }
  /** A summary line, then the diff (capped unless verbose). */
  | { kind: "diff"; summary: Line; patch: string; verbose: boolean }
  | { kind: "todos"; todos: Todo[] }
  /** A new file: the summary, then its first lines numbered from 1, then how many more there are. */
  | { kind: "write-preview"; summary: Line; lines: string[]; more: number }
  /** A running subagent: what it is doing now and how many tools it has started. */
  | { kind: "agent-progress"; progress?: string; toolUses: number };

export interface ToolView {
  /** Display name, e.g. "Update" for Edit or "srv - tool (MCP)". */
  title: string;
  /** Shown inside the parentheses after the title; empty means no parentheses. */
  args: string;
  /** A colored label before the header (subagent type); `agent` is the name to pass to agentColor. */
  badge?: { text: string; agent: string };
  result: ResultView;
}

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
export type ToolViewInput = Pick<ToolItem, "name" | "summary" | "status" | "input" | "output" | "progress" | "progressCount">;

/** The message and tool dot: macOS terminals draw ⏺ well; elsewhere it is often missing or double width. */
export function dotGlyph(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "⏺" : "●";
}

/** What the agent sends back for a tool cut short by esc (agent.ts INTERRUPTED). */
const INTERRUPTED = "[interrupted by user]";
/** The prefix agent.ts puts before a user's "No, and tell Tropos…" feedback. */
const FEEDBACK_PREFIX = "The user declined this action and said: ";
const PLAIN_DECLINE_PREFIX = "The user declined this action.";

const PREVIEW_LINES = 3;
const WRITE_PREVIEW_LINES = 10;
const BASH_ARG_LINES = 2;
const BASH_ARG_CHARS = 160;
const ARG_CHARS = 160;
const MCP_VALUE_CHARS = 40;

// ---------- small helpers ----------

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line: sanitized, whitespace runs collapsed. */
function flat(text: string): string {
  return sanitizeForTerminal(text).replace(/\s+/g, " ").trim();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function str(input: unknown, key: string): string | undefined {
  const v = record(input)[key];
  return typeof v === "string" ? v : undefined;
}

/** A path shown relative to the cwd when it lies inside it; anything else stays as given. */
export function displayPath(path: string, cwd?: string): string {
  if (!cwd || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return path;
  return rel;
}

/** The text of a tool result: a string as is, or the text blocks of a block list joined. */
export function contentText(content: ToolResultContent | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
    .join("\n");
}

function outputLines(output: ToolOutput | undefined): string[] {
  const text = sanitizeForTerminal(contentText(output?.content)).replace(/\s+$/, "");
  return text === "" ? [] : text.split("\n");
}

/** The first `n` lines (all when verbose), then a dim "… +N lines (ctrl+o to expand)". */
function preview(lines: string[], verbose: boolean, color?: ColorKey, n = PREVIEW_LINES): Line[] {
  const shown = verbose ? lines : lines.slice(0, n);
  const out: Line[] = shown.map((l) => [{ text: l, ...(color ? { color } : {}) }]);
  const more = lines.length - shown.length;
  if (more > 0) out.push([{ text: `… +${plural(more, "line")} (ctrl+o to expand)`, color: "muted" }]);
  return out;
}

/** A summary line with its leading number in bold: "Found **3** files". */
function counted(before: string, n: number, word: string, after = ""): Line {
  return [{ text: before }, { text: String(n), bold: true }, { text: ` ${n === 1 ? word : `${word}s`}${after}` }];
}

function leadingNumber(summary: string | undefined): number | undefined {
  const m = summary ? /^(\d+)\b/.exec(summary) : null;
  return m ? Number(m[1]) : undefined;
}

/** In verbose mode a summary is followed by the full output. */
function withFull(line: Line, output: ToolOutput | undefined, verbose: boolean): ResultView {
  const lines: Line[] = [line];
  if (verbose) for (const l of outputLines(output)) lines.push([{ text: l, color: "muted" }]);
  return { kind: "lines", lines };
}

// ---------- headers ----------

function bashArgs(command: string): string {
  const lines = sanitizeForTerminal(command).trim().split("\n");
  let text = lines.slice(0, BASH_ARG_LINES).join("\n");
  const cut = lines.length > BASH_ARG_LINES || text.length > BASH_ARG_CHARS;
  if (text.length > BASH_ARG_CHARS) text = text.slice(0, BASH_ARG_CHARS - 1);
  return cut ? `${text.trimEnd()}…` : text;
}

function searchArgs(input: unknown, cwd: string | undefined): string {
  const pattern = str(input, "pattern");
  const path = str(input, "path");
  const parts = [`pattern: ${JSON.stringify(flat(pattern ?? ""))}`];
  if (path) parts.push(`path: ${JSON.stringify(flat(displayPath(path, cwd)))}`);
  return parts.join(", ");
}

function mcpValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return clip(flat(text), MCP_VALUE_CHARS);
}

/** `mcp__srv__tool` → ["srv", "tool"]. Server names can't contain "__", so the first one splits. */
export function parseMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const at = rest.indexOf("__");
  if (at <= 0 || at + 2 >= rest.length) return undefined;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

interface Header {
  title: string;
  args: string;
  badge?: ToolView["badge"];
}

function header(item: ToolViewInput, cwd: string | undefined): Header {
  const { input } = item;
  const path = (key = "file_path") => flat(displayPath(str(input, key) ?? item.summary, cwd));
  switch (item.name) {
    case "Bash":
      return { title: "Bash", args: bashArgs(str(input, "command") ?? item.summary) };
    case "Read":
      return { title: "Read", args: path() };
    case "Edit":
      return { title: "Update", args: path() };
    case "Write":
      return { title: "Write", args: path() };
    case "Glob":
    case "Grep":
      return { title: "Search", args: str(input, "pattern") === undefined ? clip(flat(item.summary), ARG_CHARS) : searchArgs(input, cwd) };
    case "WebFetch":
      return { title: "Fetch", args: clip(flat(str(input, "url") ?? item.summary), ARG_CHARS) };
    case "Agent": {
      const type = flat(str(input, "subagent_type") ?? "general-purpose");
      const description = str(input, "description");
      return {
        title: "Agent",
        args: clip(flat(description ?? item.summary.replace(/^[^:]*:\s*/, "")), ARG_CHARS),
        badge: { text: type, agent: type },
      };
    }
    case "Skill":
      return { title: "Skill", args: flat(str(input, "skill") ?? item.summary) };
    case "TodoWrite":
      return { title: "Update Todos", args: "" };
    case "Memory": {
      const action = str(input, "action");
      const target = str(input, "target");
      return { title: "Memory", args: action && target ? flat(`${action} ${target}`) : clip(flat(item.summary), ARG_CHARS) };
    }
    case "SessionSearch": {
      const query = str(input, "query");
      return { title: "Search sessions", args: query === undefined ? clip(flat(item.summary), ARG_CHARS) : clip(JSON.stringify(flat(query)), ARG_CHARS) };
    }
    case "SkillManage": {
      const action = str(input, "action");
      const name = str(input, "name");
      return { title: "SkillManage", args: action && name ? flat(`${action} ${name}`) : clip(flat(item.summary), ARG_CHARS) };
    }
    case "BashOutput":
    case "KillShell":
      return { title: item.name, args: flat(str(input, "job_id") ?? item.summary) };
  }
  const mcp = parseMcpName(item.name);
  if (mcp) {
    const entries = Object.entries(record(input)).map(([k, v]) => `${flat(k)}: ${mcpValue(v)}`);
    return { title: `${flat(mcp.server)} - ${flat(mcp.tool)} (MCP)`, args: clip(entries.join(", "), ARG_CHARS) };
  }
  return { title: flat(item.name), args: clip(flat(item.summary), ARG_CHARS) };
}

// ---------- results ----------

function isInterrupted(output: ToolOutput | undefined): boolean {
  const lines = contentText(output?.content).trim().split("\n");
  return lines.at(-1)?.trim() === INTERRUPTED;
}

function deniedResult(output: ToolOutput | undefined): ResultView {
  const text = sanitizeForTerminal(contentText(output?.content)).trim();
  if (text.startsWith(FEEDBACK_PREFIX)) {
    const feedback = text.slice(FEEDBACK_PREFIX.length).trim();
    return { kind: "lines", lines: feedback.split("\n").map((l) => [{ text: l }]) };
  }
  if (text === "" || text.startsWith(PLAIN_DECLINE_PREFIX)) return { kind: "lines", lines: [[{ text: "Declined", color: "warning" }]] };
  // A deny rule or a hook: its reason says why, which is more use than a bare "Declined".
  return { kind: "lines", lines: [[{ text: text.split("\n")[0]!, color: "warning" }]] };
}

function diffSummary(diff: DiffDisplay): Line {
  const parts: Line = [];
  if (diff.added > 0 || diff.removed === 0) parts.push(...counted("Added ", diff.added, "line"));
  if (diff.removed > 0) parts.push(...counted(parts.length ? ", removed " : "Removed ", diff.removed, "line"));
  return parts;
}

/** The lines of a brand-new file, recovered from its all-added patch. */
function addedLines(patch: string): string[] {
  return patchBody(patch)
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1));
}

function diffResult(item: ToolViewInput, diff: DiffDisplay, cwd: string | undefined, verbose: boolean): ResultView {
  const created = item.output?.summary?.startsWith("created") ?? false;
  if (item.name === "Write" && created) {
    const all = addedLines(sanitizeForTerminal(diff.patch));
    const shown = verbose ? all : all.slice(0, WRITE_PREVIEW_LINES);
    return {
      kind: "write-preview",
      summary: [...counted("Wrote ", all.length, "line", ` to ${flat(displayPath(diff.path, cwd))}`)],
      lines: shown,
      more: all.length - shown.length,
    };
  }
  return { kind: "diff", summary: diffSummary(diff), patch: sanitizeForTerminal(diff.patch), verbose };
}

function todosFromInput(input: unknown): Todo[] | undefined {
  const todos = record(input).todos;
  if (!Array.isArray(todos)) return undefined;
  return todos.filter((t): t is Todo => !!t && typeof t === "object" && typeof (t as Todo).content === "string" && typeof (t as Todo).status === "string");
}

function summaryLine(summary: string): Line {
  return [{ text: capitalize(flat(summary)) }];
}

/** The result for a tool that finished normally (status done). */
function doneResult(item: ToolViewInput, cwd: string | undefined, verbose: boolean): ResultView {
  const { output, input } = item;
  const summary = output?.summary;
  const display = output?.display;

  if (display?.kind === "todos") return { kind: "todos", todos: display.todos };
  if (item.name === "TodoWrite") {
    const todos = todosFromInput(input);
    if (todos) return { kind: "todos", todos };
  }
  if (display?.kind === "diff") return diffResult(item, display, cwd, verbose);
  if (output === undefined) return { kind: "none" };

  const n = leadingNumber(summary);
  switch (item.name) {
    case "Bash": {
      if (record(input).run_in_background === true && summary) {
        return { kind: "lines", lines: [[{ text: `Running in background (${flat(summary)})` }]] };
      }
      const lines = outputLines(output);
      if (lines.length === 0 || (lines.length === 1 && lines[0] === "(no output)")) {
        return { kind: "lines", lines: [[{ text: "(No output)", color: "muted" }]] };
      }
      return { kind: "lines", lines: preview(lines, verbose) };
    }
    case "Read":
      if (summary && /^\d+ lines?$/.test(summary)) return withFull(counted("Read ", n!, "line"), output, verbose);
      if (summary === "empty") return withFull(counted("Read ", 0, "line"), output, verbose);
      break;
    case "Glob":
      if (n !== undefined) return withFull(counted("Found ", n, "file"), output, verbose);
      break;
    case "Grep":
      if (n !== undefined) {
        const mode = str(input, "output_mode");
        return withFull(counted("Found ", n, mode === "content" ? "line" : "file"), output, verbose);
      }
      break;
    case "WebFetch": {
      const m = summary ? /^(.+?) · (\d{3})$/.exec(summary) : null;
      if (m) {
        const text = m[1] === "redirect" ? `Redirected (${m[2]})` : `Received ${m[1]} (${m[2]})`;
        return withFull([{ text: flat(text) }], output, verbose);
      }
      break;
    }
    case "Agent":
      if (n !== undefined) return withFull([{ text: `Done (${plural(n, "tool use")})` }], output, verbose);
      break;
    case "SessionSearch":
      if (n !== undefined) return withFull(counted("Found ", n, "session"), output, verbose);
      break;
  }
  if (display?.kind === "text" && !summary) return withFull([{ text: flat(display.text) }], output, verbose);
  if (summary) return withFull(summaryLine(summary), output, verbose);
  // No summary (most MCP tools): show the start of the output itself.
  const lines = outputLines(output);
  return lines.length ? { kind: "lines", lines: preview(lines, verbose) } : { kind: "none" };
}

function runningResult(item: ToolViewInput): ResultView {
  if (item.name === "Agent") {
    return { kind: "agent-progress", ...(item.progress ? { progress: flat(item.progress) } : {}), toolUses: item.progressCount ?? 0 };
  }
  if (item.progress) return { kind: "lines", lines: [[{ text: flat(item.progress), color: "muted" }]] };
  if (item.name === "Bash") return { kind: "lines", lines: [[{ text: "Running…", color: "muted" }]] };
  return { kind: "none" };
}

function resultView(item: ToolViewInput, cwd: string | undefined, verbose: boolean): ResultView {
  switch (item.status) {
    case "running":
      return runningResult(item);
    case "denied":
      return deniedResult(item.output);
    case "error": {
      if (isInterrupted(item.output)) return { kind: "lines", lines: [[{ text: "Interrupted", color: "muted" }]] };
      const lines = outputLines(item.output);
      if (lines.length === 0) return { kind: "lines", lines: [[{ text: "Error", color: "danger" }]] };
      return { kind: "lines", lines: preview(lines, verbose, "danger") };
    }
    case "done":
      return doneResult(item, cwd, verbose);
  }
}

/** How a tool row looks: its header and the result under the gutter. `cwd` makes paths relative. */
export function toolView(item: ToolViewInput, cwd?: string, opts: { verbose?: boolean } = {}): ToolView {
  const verbose = opts.verbose ?? false;
  return { ...header(item, cwd), result: resultView(item, cwd, verbose) };
}

// ---------- turn footer ----------

const TURN_VERBS = ["Worked", "Turned", "Pivoted", "Orbited", "Revolved"] as const;

/** "12s", "1m 5s", "1h 2m". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "Worked for 12s"; the verb is picked from the seconds so the same turn always reads the same. */
export function turnDoneText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${TURN_VERBS[s % TURN_VERBS.length]} for ${formatDuration(s)}`;
}
