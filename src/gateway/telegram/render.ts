// src/gateway/telegram/render.ts — pure functions turning agent events into Telegram text (plain text, no parse_mode).
import type { PermissionPrompt } from "../../agent/events";
import type { Message } from "../../api/model";
import type { PanelData } from "../../ui/runtime";
import type { SessionState } from "../../web/protocol";
import type { TurnEndReason } from "../../agent/events";
import type { WorktreeSummary } from "../types";
import type { InlineKeyboard } from "./api";

export const MAX_MESSAGE = 4096;

/** Splits at paragraph/line/word boundaries so every part is at most `max` characters. */
export function splitMessage(text: string, max = MAX_MESSAGE): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 2) cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut < max / 4) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const REDACTED = "‹redacted›";

/** Hides credentials in command text before it goes to a chat (summaries and tool lines). */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(Bearer|Basic)\s+[^\s'"]+/gi, `$1 ${REDACTED}`)
    .replace(/(\b[\w.-]*(?:TOKEN|KEY|SECRET|PASS(?:WORD)?)[\w.-]*=)("[^"]*"|'[^']*'|[^\s'"]+)/gi, `$1${REDACTED}`)
    .replace(/[A-Za-z0-9_-]{32,}/g, REDACTED);
}

const SUMMARY_FILES = 10;
const SUMMARY_COMMANDS = 8;

function capped(items: string[], max: number, sep: string, extra = 0): string {
  const more = Math.max(items.length - max, 0) + extra;
  return more > 0 ? `${items.slice(0, max).join(sep)} and ${more} more` : items.join(sep);
}

/** What a turn changed and ran, for a chat where it happened without asking. Nothing when it did neither. */
export function taskSummaryText(done: { files: string[]; commands: string[]; moreFiles?: number; moreCommands?: number }): string | undefined {
  const files = [...new Set(done.files)].map((f) => oneLine(f, 100));
  const lines: string[] = [];
  const commands = done.commands.map((c) => oneLine(redactSecrets(c), 80));
  if (files.length > 0) lines.push(`Changed: ${capped(files, SUMMARY_FILES, ", ", done.moreFiles)}`);
  if (commands.length > 0) lines.push(`Ran: ${capped(commands, SUMMARY_COMMANDS, " · ", done.moreCommands)}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export interface ToolLine {
  id: string;
  name: string;
  summary: string;
  status?: "done" | "error" | "denied";
}

/** One short status message for a run of consecutive tool calls. */
export function renderToolBatch(lines: ToolLine[]): string {
  return lines
    .map((l) => {
      const mark = l.status === "error" ? " (failed)" : l.status === "denied" ? " (denied)" : "";
      return `• ${oneLine(redactSecrets(`${l.name}: ${l.summary}`), 160)}${mark}`;
    })
    .join("\n");
}

export function assistantText(message: Message): string {
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
}

/** callback_data: `a:<ask id>:<y|n>` — a few bytes, well under Telegram's 64. */
export function callbackData(id: number, approve: boolean): string {
  return `a:${id}:${approve ? "y" : "n"}`;
}

export function parseCallbackData(data: string | undefined): { id: number; approve: boolean } | undefined {
  const m = /^a:(\d{1,12}):([yn])$/.exec(data ?? "");
  return m ? { id: Number(m[1]), approve: m[2] === "y" } : undefined;
}

/** callback_data: `p:<project id>` — ids are at most 40 characters, so well under Telegram's 64 bytes. */
export function projectCallbackData(id: string): string {
  return `p:${id}`;
}

export function parseProjectCallback(data: string | undefined): string | undefined {
  return /^p:([a-z0-9][a-z0-9-]{0,39})$/.exec(data ?? "")?.[1];
}

/** One button per project; the current one is marked and does nothing new. */
export function projectKeyboard(projects: { id: string; name: string }[], currentId: string): InlineKeyboard {
  return {
    inline_keyboard: projects.map((p) => [{ text: `${p.id === currentId ? "• " : ""}${oneLine(p.name, 40)}`, callback_data: projectCallbackData(p.id) }]),
  };
}

/** The /project message: where the chat is and what else it can switch to. */
export function projectListText(projects: { id: string; name: string }[], currentId: string): string {
  const current = projects.find((p) => p.id === currentId);
  return [
    `Project: ${current ? `${oneLine(current.name, 60)} (${current.id})` : currentId}`,
    "",
    "Switch with a button, or /project <id>:",
    ...projects.map((p) => `${p.id === currentId ? "•" : " "} ${p.id}  ${oneLine(p.name, 60)}`),
  ].join("\n");
}

export function permissionKeyboard(id: number): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: callbackData(id, true) },
        { text: "Deny", callback_data: callbackData(id, false) },
      ],
    ],
  };
}

/**
 * The text of a permission request, and whether it shows everything that would be approved. A command or a file
 * body padded past the limits could hide its tail behind an Approve button, so the adapter denies what is cut.
 */
export function permissionView(prompt: PermissionPrompt): { text: string; complete: boolean } {
  const SUMMARY = 500;
  const REASON = 300;
  const HEADER = 200;
  const PREVIEW = 1500;
  const TOTAL = 3800;
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  let complete = flat(prompt.summary).length <= SUMMARY && (!prompt.reason || flat(prompt.reason).length <= REASON);
  const lines = [`Permission needed: ${prompt.toolName}`, oneLine(prompt.summary, SUMMARY)];
  if (prompt.reason) lines.push(oneLine(prompt.reason, REASON));
  if (prompt.preview) {
    if (prompt.preview.text.length > PREVIEW || flat(prompt.preview.header).length > HEADER) complete = false;
    const body = prompt.preview.text.length > PREVIEW ? `${prompt.preview.text.slice(0, PREVIEW)}\n…` : prompt.preview.text;
    lines.push("", oneLine(prompt.preview.header, HEADER), body);
  }
  const text = lines.join("\n");
  if (text.length > TOTAL) complete = false;
  return { text: text.slice(0, TOTAL), complete };
}

export function permissionText(prompt: PermissionPrompt): string {
  return permissionView(prompt).text;
}

export function turnEndNote(reason: TurnEndReason): string | undefined {
  switch (reason) {
    case "aborted":
      return "Stopped.";
    case "max_turns":
      return "Stopped: reached the turn limit.";
    case "max_tokens":
      return "(The answer was cut off at the output limit.)";
    case "context_exceeded":
      return "The conversation is too long. Send /new to start a fresh one.";
    case "refusal":
      return "(The model declined to answer.)";
    case "blocked":
      return "Blocked by a hook.";
    case "error":
      return "The turn ended with an error.";
    default:
      return undefined;
  }
}

export function statusText(s: SessionState, project?: { id: string; name: string }): string {
  const cost = s.totalCostUsd === undefined ? "unknown" : `$${s.totalCostUsd.toFixed(4)}`;
  return [...(project ? [`Project: ${oneLine(project.name, 60)} (${project.id})`] : []), `Model: ${s.model}`, `Mode: ${s.mode}`, `Busy: ${s.busy ? "yes" : "no"}`, `Turns: ${s.turns}`, `Cost: ${cost}`].join("\n");
}

export const HELP_TEXT = [
  "Send a message to talk to the agent.",
  "/stop  stop the running turn",
  "/new  start a fresh session",
  "/status  project, model, mode and cost",
  "/project  show the project, or /project <id> to switch",
  "/autonomy  show the autonomy level, or lower it",
  "/learned  what I saved; /learned undo takes back the newest",
  "/login  a code to log a browser in to the dashboard (owner, private chat)",
  "/<name>  run one of your skills or commands",
].join("\n");

/** `/learned`: the newest saves, one line each, with how to take the latest back. */
export function learnedText(panel: PanelData, limit = 10): string {
  const items = panel.sections.flatMap((section) => section.items).slice(0, limit);
  if (items.length === 0) return panel.empty ?? "Nothing learned yet.";
  const lines = items.map((item) => {
    const detail = [item.hint, item.aside].filter(Boolean).join(", ");
    return `• ${oneLine(item.label, 200)}${detail ? ` (${detail})` : ""}`;
  });
  return [...lines, "Send /learned undo to take back the newest."].join("\n");
}

export const BOT_COMMANDS = [
  { command: "stop", description: "Stop the running turn" },
  { command: "new", description: "Start a fresh session" },
  { command: "status", description: "Project, model, mode and cost" },
  { command: "project", description: "Show or switch the project" },
  { command: "autonomy", description: "Show or lower the autonomy level" },
  { command: "login", description: "log a browser in to the dashboard" },
  { command: "learned", description: "What I learned, with undo" },
  { command: "start", description: "Show help" },
];

// ---- end-of-task buttons for a chat working in a git worktree ----

export type WorktreeButton = "merge" | "pr" | "keep" | "discard" | "discard!" | "cancel";

/** callback_data: `wt:<x>`. */
export function parseWorktreeCallback(data: string | undefined): WorktreeButton | undefined {
  const m = /^wt:(merge|pr|keep|discard!?|cancel)$/.exec(data ?? "");
  return m ? (m[1] as WorktreeButton) : undefined;
}

/** What the task changed, for the message that carries the buttons. */
export function worktreeText(s: WorktreeSummary): string {
  const files = `${s.changedFiles} file${s.changedFiles === 1 ? "" : "s"} changed`;
  const commits = s.commitsAhead > 0 ? `, ${s.commitsAhead} commit${s.commitsAhead === 1 ? "" : "s"}` : "";
  return `Changes on ${s.branch}: ${files}${commits}.`;
}

/** Merge, Open PR (only with `gh` ready), Keep branch, Discard. */
export function worktreeKeyboard(s: WorktreeSummary): InlineKeyboard {
  const button = (text: string, action: string) => ({ text, callback_data: `wt:${action}` });
  return {
    inline_keyboard: [[button("Merge", "merge"), ...(s.canPr ? [button("Open PR", "pr")] : [])], [button("Keep branch", "keep"), button("Discard", "discard")]],
  };
}

/** Discard throws the work away, so it takes a second tap. */
export function discardConfirmKeyboard(): InlineKeyboard {
  return { inline_keyboard: [[{ text: "Yes, discard", callback_data: "wt:discard!" }, { text: "Cancel", callback_data: "wt:cancel" }]] };
}
