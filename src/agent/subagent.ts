// src/agent/subagent.ts
import type { Model } from "../api/model";
import type { MessageParam } from "../session/store";
import { subagentIdentityLine } from "../context/identity";
import type { Effort } from "../config/constants";
import { errorText } from "../error-text";
import type { PermissionContext } from "../permissions/engine";
import { MemoryTodoStore } from "../tools/todo/todo";
import type { AnyTool, ToolContext, ToolOutput } from "../tools/types";
import { Agent, INTERRUPTED, type AgentHooks } from "./agent";
import type { PermissionAnswer, PermissionPrompt } from "./events";

/** What a subagent needs from its definition (extensions/agents.ts AgentDefinition satisfies this). */
export interface SubagentDefinition {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  prompt: string;
  emoji?: string;
}

/** Everything a subagent shares with the session that starts it. */
export interface SubagentDeps {
  model: Model;
  /** The parent's tools; the child gets a filtered copy and never the Agent tool. */
  tools: AnyTool[];
  system: string;
  config(): { model: string; effort: Effort; refusalFallback: boolean };
  permissions(): PermissionContext;
  /** Must be serialized with the parent's prompts (see serializeAsks). */
  askPermission(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer>;
  contextText(): Promise<string>;
  nonce?(): string;
  /** Saves a "don't ask again" rule, as the main agent does. */
  onAllowAlways?(rule: string): Promise<void> | void;
  /** Adds the subagent's spend to the session's cost (undefined = a model without a known price). */
  recordCost?(costUsd: number | undefined): void;
  /** Opens a transcript for one subagent run; a failure here is ignored and the run goes on unsaved. */
  openTranscript?(agent: string): Promise<{ appendMessage(m: MessageParam): Promise<void> }>;
  hooks?: AgentHooks;
  beforeChange?(): Promise<void>;
  postWrite?(paths: string[], signal: AbortSignal): Promise<string | null>;
}

export const DEFAULT_SUBAGENT_TURNS = 50;
/** An agent file can raise its turn limit only this far: parallel subagents multiply the spend. */
export const MAX_SUBAGENT_TURNS = 200;
export const AGENT_TOOL_NAME = "Agent";

/** Tools only the chief holds: no subagent or specialist delegates, schedules or changes Tropos's setup. */
export const HUB_ONLY_TOOLS: ReadonlySet<string> = new Set([AGENT_TOOL_NAME, "AgentManage", "Cron", "TroposSetup"]);

/** What one subagent run came to, handed to `observe` once on every exit path. */
export interface SubagentRun {
  messages: MessageParam[];
  toolUses: number;
  turns: number;
  /** undefined when any reply came from a model without a known price. */
  costUsd: number | undefined;
  ok: boolean;
  durationMs: number;
  report: string;
}

/** Short model names agent files use (Claude Code's aliases), mapped to current model ids. */
const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1",
};

export function resolveAgentModel(model: string | undefined, parent: string): string {
  if (!model || model === "inherit") return parent;
  return MODEL_ALIASES[model.toLowerCase()] ?? model;
}

/** `name`, or `prefix*` for every tool starting with prefix (e.g. `mcp__github__*`). */
function listed(names: string[], tool: string): boolean {
  return names.some((n) => n === tool || (n.endsWith("*") && tool.startsWith(n.slice(0, -1))));
}

/** The child's tools: the definition's list (missing or `*` = all), minus disallowed ones, never a hub-only tool. */
export function filterTools(tools: AnyTool[], def: Pick<SubagentDefinition, "tools" | "disallowedTools">): AnyTool[] {
  const wanted = def.tools && !(def.tools.length === 1 && def.tools[0] === "*") ? def.tools : undefined;
  return tools.filter(
    (t) => !HUB_ONLY_TOOLS.has(t.name) && (!wanted || listed(wanted, t.name)) && !listed(def.disallowedTools ?? [], t.name),
  );
}

export function subagentSystem(base: string, def: SubagentDefinition): string {
  return (
    `${base}\n\n# Agent: ${def.name}\n${subagentIdentityLine(def)}\n` +
    "You are running as a subagent: another Tropos agent gave you the task in the first user message. " +
    "Work on it autonomously; nobody will answer questions. Your final message is returned to that agent as your result, " +
    "so make it a complete, self-contained report.\n\n" +
    def.prompt.trim()
  );
}

/** Wraps a permission prompt so prompts from the main agent and its subagents never overlap in the UI. */
export function serializeAsks(
  ask: (prompt: PermissionPrompt, signal: AbortSignal) => Promise<PermissionAnswer>,
): (prompt: PermissionPrompt, signal: AbortSignal) => Promise<PermissionAnswer> {
  let queue: Promise<unknown> = Promise.resolve();
  return (prompt, signal) => {
    const next = queue.then(() => (signal.aborted ? ({ kind: "deny" } as PermissionAnswer) : ask(prompt, signal)));
    queue = next.catch(() => {});
    return next;
  };
}

/** Runs one subagent to completion and turns its last reply into the Agent tool's result. */
export async function runSubagent(
  def: SubagentDefinition,
  prompt: string,
  deps: SubagentDeps,
  ctx: ToolContext,
  observe?: (run: SubagentRun) => void,
): Promise<ToolOutput> {
  const startedAt = Date.now();
  let cwd = ctx.cwd();
  const toolContext: Omit<ToolContext, "signal"> = {
    cwd: () => cwd,
    setCwd: (dir) => {
      cwd = dir;
    },
    allowedDirs: ctx.allowedDirs,
    readState: ctx.readState,
    todos: new MemoryTodoStore(),
    jobs: ctx.jobs,
    shell: ctx.shell,
    // A sandboxed session's subagents must not get the host shell back.
    exec: ctx.exec,
  };
  // A transcript that can't be opened or written must never stop the work.
  const transcript = await deps.openTranscript?.(def.name).catch(() => null);
  let toolUses = 0;
  let turns = 0;
  let lastError: string | undefined;
  let cost: number | undefined = 0;
  const child = new Agent({
    model: deps.model,
    tools: filterTools(deps.tools, def),
    system: subagentSystem(deps.system, def),
    config: () => {
      const parent = deps.config();
      return { ...parent, model: resolveAgentModel(def.model, parent.model) };
    },
    permissions: deps.permissions,
    askPermission: deps.askPermission,
    onAllowAlways: deps.onAllowAlways,
    contextText: deps.contextText,
    nonce: deps.nonce,
    persist: async (message) => {
      await transcript?.appendMessage(message).catch(() => {});
    },
    toolContext,
    maxTurns: Math.min(def.maxTurns ?? DEFAULT_SUBAGENT_TURNS, MAX_SUBAGENT_TURNS),
    // The task prompt comes from the parent agent, not the user: UserPromptSubmit doesn't fire for it.
    hooks: deps.hooks && { has: (event) => event !== "UserPromptSubmit" && deps.hooks!.has(event), run: (...args) => deps.hooks!.run(...args) },
    stopEvent: { event: "SubagentStop", agentType: def.name },
    beforeChange: deps.beforeChange,
    postWrite: deps.postWrite,
    emit: (event) => {
      if (event.type === "tool_start") ctx.progress?.(`${event.name} ${event.summary}`.trim());
      else if (event.type === "tool_end") toolUses++;
      else if (event.type === "assistant") turns++;
      else if (event.type === "notice" && event.level === "error") lastError = event.text;
      // Only the cost: the child's context size says nothing about the parent's window.
      else if (event.type === "usage") {
        deps.recordCost?.(event.costUsd);
        cost = cost === undefined || event.costUsd === undefined ? undefined : cost + event.costUsd;
      }
    },
  });
  // Observers never break a run.
  const finish = (out: ToolOutput): ToolOutput => {
    try {
      observe?.({
        messages: child.messages,
        toolUses,
        turns,
        costUsd: cost,
        ok: !out.isError,
        durationMs: Date.now() - startedAt,
        report: typeof out.content === "string" ? out.content : JSON.stringify(out.content),
      });
    } catch {}
    return out;
  };
  let reason;
  try {
    reason = await child.run(prompt, ctx.signal);
  } catch (err) {
    return finish({ content: `The ${def.name} agent failed: ${errorText(err)}`, isError: true });
  }
  if (reason === "aborted") return finish({ content: INTERRUPTED, isError: true });
  const last = lastAssistantText(child);
  const footer = `(${def.name} · ${toolUses} tool ${toolUses === 1 ? "use" : "uses"} · ${turns} ${turns === 1 ? "turn" : "turns"})`;
  if (reason !== "end_turn" && reason !== "max_tokens") {
    const why = lastError ?? `it stopped early (${reason})`;
    return finish({ content: `The ${def.name} agent did not finish: ${why}${last ? `\n\nLast reply:\n${last}` : ""}\n\n${footer}`, isError: true, summary: `stopped: ${reason}` });
  }
  return finish({ content: `${last || "(the agent returned no text)"}\n\n${footer}`, summary: `${toolUses} tool ${toolUses === 1 ? "use" : "uses"}` });
}

function lastAssistantText(agent: Agent): string {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]!;
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (text) return text;
  }
  return "";
}
