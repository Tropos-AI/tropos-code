// src/hooks/output.ts
import type { HookEvent } from "../config/settings";
import { errorText } from "../error-text";

/**
 * What the hooks for one event decided, merged across every hook that ran.
 * - `blocked`: exit 2 or `decision: "block"`. PreToolUse: deny the tool with this reason. PostToolUse(Failure):
 *   append it to the result. UserPromptSubmit: don't send the prompt. Stop/SubagentStop: keep going with it as
 *   the next user message.
 * - `stop`: `continue: false`; the turn ends with this reason shown.
 * - `permission`/`permissionReason`/`updatedInput`: PreToolUse only.
 * - `messages`: `systemMessage` text for the user; `errors`: non-blocking failures for a warning notice.
 */
export interface HookOutcome {
  blocked?: string;
  permission?: "allow" | "deny" | "ask";
  permissionReason?: string;
  updatedInput?: unknown;
  additionalContext: string[];
  stop?: string;
  messages: string[];
  errors: string[];
}

/** How one hook process ended. */
export interface HookExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Events where exit 2 or `decision: "block"` means something; elsewhere exit 2 is just a failed hook. */
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
]);

/** Events whose plain (non-JSON) stdout is context for the model rather than noise. */
const STDOUT_CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(["UserPromptSubmit", "SessionStart"]);

const PERMISSION_RANK = { allow: 1, ask: 2, deny: 3 } as const;
type Permission = keyof typeof PERMISSION_RANK;

export function emptyOutcome(): HookOutcome {
  return { additionalContext: [], messages: [], errors: [] };
}

/** A short name for a hook in notices: its first line, cut at 120 characters. */
export function hookLabel(command: string): string {
  const line = command.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isPermission(value: unknown): value is Permission {
  return value === "allow" || value === "deny" || value === "ask";
}

/** Turns one hook's exit code and output into its share of the outcome, using Claude Code's wire format. */
export function interpretHookResult(event: HookEvent, command: string, run: HookExecution): HookOutcome {
  const out = emptyOutcome();
  const label = hookLabel(command);
  const stderr = run.stderr.trim();

  if (run.exitCode === 2) {
    if (BLOCKING_EVENTS.has(event)) out.blocked = stderr || `Blocked by a hook (${label})`;
    else out.errors.push(`${label}: exit 2${stderr ? `: ${stderr.split("\n")[0]}` : ""}`);
    return out;
  }
  if (run.exitCode !== 0) {
    out.errors.push(`${label}: exit ${run.exitCode}${stderr ? `: ${stderr.split("\n")[0]}` : ""}`);
    return out;
  }

  const stdout = run.stdout.trim();
  if (!stdout.startsWith("{")) {
    if (stdout && STDOUT_CONTEXT_EVENTS.has(event)) out.additionalContext.push(stdout);
    return out;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    out.errors.push(`${label}: invalid JSON output: ${errorText(err)}`);
    return out;
  }
  if (!isRecord(parsed)) {
    out.errors.push(`${label}: JSON output is not an object`);
    return out;
  }

  if (parsed.continue === false) out.stop = nonEmpty(parsed.stopReason) ?? "Stopped by a hook";
  const systemMessage = nonEmpty(parsed.systemMessage);
  if (systemMessage) out.messages.push(systemMessage);
  // "approve" is deliberately ignored: a legacy approval must not skip the permission prompt.
  if (parsed.decision === "block" && BLOCKING_EVENTS.has(event)) {
    out.blocked = nonEmpty(parsed.reason) ?? `Blocked by a hook (${label})`;
  }

  const specific = parsed.hookSpecificOutput;
  if (specific === undefined) return out;
  if (!isRecord(specific)) {
    out.errors.push(`${label}: hookSpecificOutput is not an object`);
    return out;
  }
  if (specific.hookEventName !== undefined && specific.hookEventName !== event) {
    out.errors.push(`${label}: hookSpecificOutput is for ${String(specific.hookEventName)}, not ${event}`);
    return out;
  }
  if (event === "PreToolUse") {
    const decision = specific.permissionDecision;
    if (isPermission(decision)) {
      out.permission = decision;
      const reason = nonEmpty(specific.permissionDecisionReason);
      if (reason) out.permissionReason = reason;
    } else if (decision !== undefined) {
      out.errors.push(`${label}: unknown permissionDecision ${JSON.stringify(decision)}`);
    }
    if (specific.updatedInput !== undefined) {
      if (isRecord(specific.updatedInput)) out.updatedInput = specific.updatedInput;
      else out.errors.push(`${label}: updatedInput is not an object`);
    }
  }
  const context = nonEmpty(specific.additionalContext);
  if (context) out.additionalContext.push(context);
  return out;
}

/**
 * Folds per-hook outcomes, given in config order (settings before plugins), into one. The strictest permission
 * wins (deny > ask > allow) and brings its reason; `updatedInput` is the last hook's; reasons and lists are joined
 * in order so the result doesn't depend on which hook finished first.
 */
export function mergeHookResults(results: readonly HookOutcome[]): HookOutcome {
  const merged = emptyOutcome();
  const blocked: string[] = [];
  const stops: string[] = [];
  for (const r of results) {
    if (r.blocked !== undefined) blocked.push(r.blocked);
    if (r.stop !== undefined) stops.push(r.stop);
    if (r.permission && (!merged.permission || PERMISSION_RANK[r.permission] > PERMISSION_RANK[merged.permission])) {
      merged.permission = r.permission;
      merged.permissionReason = r.permissionReason;
    } else if (r.permission === merged.permission && merged.permissionReason === undefined) {
      merged.permissionReason = r.permissionReason;
    }
    if (r.updatedInput !== undefined) merged.updatedInput = r.updatedInput;
    merged.additionalContext.push(...r.additionalContext);
    merged.messages.push(...r.messages);
    merged.errors.push(...r.errors);
  }
  if (blocked.length) merged.blocked = blocked.join("\n");
  if (stops.length) merged.stop = stops.join("\n");
  if (merged.permissionReason === undefined) delete merged.permissionReason;
  return merged;
}
