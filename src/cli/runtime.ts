import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, hookContext } from "../agent/agent";
import type { PermissionPrompt } from "../agent/events";
import { serializeAsks } from "../agent/subagent";
import type { Model } from "../api/model";
import type { Effort, Mode } from "../config/constants";
import { HOOK_EVENTS, addLocalAllowRule, isAnthropicModelId, type Settings } from "../config/settings";
import { environmentBlock } from "../context/environment";
import { loadMemory } from "../context/memory";
import { SYSTEM_PROMPT, buildContextText } from "../context/system-prompt";
import { LEARNED_SKILLS_DIR } from "../extensions/sources";
import { agentLabel } from "../extensions/agents";
import { createSkillManageTool } from "../memory/skill-manage";
import { loadCounters, saveCounters, type LearningCounters } from "../learning/counters";
import { FINAL_REVIEW_TIMEOUT_MS, flushWindow, LearningLoop, runReviewAgent } from "../learning/review";
import { loadIdentity } from "../context/identity";
import { runCurator } from "../learning/curator";
import { savedNotice } from "../learning/saved-notice";
import { canonicalStorePath, STORE_TOOLS, troposStorePaths } from "../learning/stores";
import { dailyNotesDir } from "../memory/daily";
import { commandMessage, expandCommand, MAX_EXTENSION_BYTES, type CommandIO } from "../extensions/commands";
import { renderSkill, skillListing } from "../extensions/skills";
import type { HookRunner } from "../hooks/runner";
import { MEMORY_LIMITS, notesLabel, notesSize, usageHeader } from "../memory/notes";
import { harnessNonce, nonceBlock } from "../context/tags";
import { isInside } from "../paths";
import { decide, type PermissionContext, type PermissionRules } from "../permissions/engine";
import { parseRule } from "../permissions/rules";
import { SessionStore, listSessions, type MessageParam } from "../session/store";
import { bashTool } from "../tools/bash/bash";
import type { ExecBackend } from "../exec/backend";
import { JobTable } from "../tools/bash/jobs";
import { resolveToolPath } from "../tools/paths";
import { ReadState } from "../tools/read-state";
import { MemoryTodoStore } from "../tools/todo/todo";
import type { SessionRole } from "../gateway/types";
import type { AnyTool, ToolContext } from "../tools/types";
import type { ListTopic } from "../ui/commands";
import type { AgentUi, CommandExpansion, ModelPrefsControl, PanelData, PanelSection, ProviderControl, Runtime } from "../ui/runtime";
import type { Theme } from "../ui/theme";
import { contextExtras, createHookRunner, extraCommands, postWrite, type Extensions, type SubagentHolder } from "./extensions";

const STORE_TOOL_NAMES: ReadonlySet<string> = new Set(STORE_TOOLS);

export interface AppContext {
  cwd: string;
  /** Tropos data dir (TROPOS_HOME or ~/.tropos). */
  home: string;
  version: string;
  settings: Settings;
  rules: PermissionRules;
  allowedDirs: string[];
  tools: AnyTool[];
  model: Model;
  /** Provider keys and model lists for /providers. */
  providers: ProviderControl;
  shell: string;
  localSettingsPath: string;
  /** Commands, skills, agents, hooks, MCP, snapshots, formatters, memory (phase 2). */
  ext: Extensions;
  /** Recent and favorite models for the /model picker. */
  modelPrefs: ModelPrefsControl;
  /** The running agent's subagent dependencies, read by the Agent tool. */
  subagents: SubagentHolder;
  env: NodeJS.ProcessEnv;
  /** Where the session came from; "channel" (a messaging chat) is untrusted input and is confined (src/gateway/policy.ts). */
  origin?: "local" | "channel";
  /** Who the session answers to; local sessions are the owner's. */
  role: SessionRole;
  /** Where Bash runs; the host when unset. */
  exec?: ExecBackend;
}

export function createToolContext(ctx: AppContext): Omit<ToolContext, "signal"> {
  let current = ctx.cwd;
  return {
    cwd: () => current,
    setCwd: (dir) => {
      current = dir;
    },
    allowedDirs: ctx.allowedDirs,
    readState: new ReadState(),
    todos: new MemoryTodoStore(),
    jobs: new JobTable(),
    shell: ctx.shell,
    exec: ctx.exec,
  };
}

/**
 * What the permission engine weighs for a session's calls. Built per call: the stores are resolved on disk each time,
 * so a store folder swapped for a link mid-session stops counting at once.
 */
export function permissionContext(ctx: AppContext, mode: Mode): PermissionContext {
  return {
    mode,
    rules: ctx.rules,
    cwd: ctx.cwd,
    home: homedir(),
    allowedDirs: ctx.allowedDirs,
    confine: ctx.origin === "channel",
    role: ctx.role,
    stores: {
      // The journal is still per project, so it is a store of its own here, held to the same no-links check.
      paths: [...troposStorePaths(ctx.home), canonicalStorePath(ctx.home, dailyNotesDir(ctx.home, ctx.cwd))].filter((p) => p !== undefined),
      askBeforeSaving: ctx.settings.learning.askBeforeSaving,
    },
  };
}

/** Hooks for a session; their session id and transcript follow /clear and resume. */
export function sessionHooks(ctx: AppContext, session: () => SessionStore, mode: () => Mode): HookRunner | undefined {
  return createHookRunner(ctx.ext, {
    sessionId: () => session().id,
    transcriptPath: () => session().path,
    cwd: ctx.cwd,
    mode,
    env: ctx.env,
    shell: ctx.shell,
  });
}

/**
 * Fires SessionStart and returns its additional context, for the next prompt. Hook messages and
 * errors are reported through `notice`.
 */
export async function sessionStart(
  hooks: HookRunner | undefined,
  source: "startup" | "resume" | "clear",
  notice: (level: "info" | "warn", text: string) => void,
  nonce: string,
): Promise<string | null> {
  if (!hooks?.has("SessionStart")) return null;
  const out = await hooks.run("SessionStart", { source }, source);
  for (const text of out.messages) notice("info", text);
  for (const text of out.errors) notice("warn", `SessionStart hook: ${text}`);
  return out.additionalContext.length > 0 ? hookContext("SessionStart", out.additionalContext, nonce) : null;
}

export async function sessionEnd(hooks: HookRunner | undefined, reason: "exit" | "clear"): Promise<void> {
  if (hooks?.has("SessionEnd")) await hooks.run("SessionEnd", { reason }, reason).catch(() => {});
}

export function makeAgent(
  ctx: AppContext,
  opts: {
    session(): SessionStore;
    history: MessageParam[];
    state(): { model: string; effort: Effort; mode: Mode };
    ui: AgentUi;
    toolContext: Omit<ToolContext, "signal">;
    maxTurns?: number;
    hooks?: HookRunner;
    /** One-shot context for the first turn, such as SessionStart hook output. */
    pending?: { take(): string | null };
    /**
     * An interactive session (the TUI or `tcode web`): it gets the first-run identity note and, when
     * learning is on, the background review. Print mode gets neither.
     */
    interactive?: boolean;
    /** Runs the background review. Defaults to `interactive`; the gateway sets it for the owner's chats only. */
    learn?: boolean;
    /** Receives the session's learning loop, so the runtime can finish it on /clear and at exit. */
    onLearning?(loop: LearningLoop): void;
    /** The learning loop's starting counters and where every change to them goes. */
    counters?: { initial: LearningCounters; save(c: LearningCounters): void };
    /** After the Identity tool saved something (headers show the new name). */
    onIdentityChange?(): void;
  },
): Agent {
  const config = () => ({ model: opts.state().model, effort: opts.state().effort, refusalFallback: ctx.settings.refusalFallback });
  const permissions = () => permissionContext(ctx, opts.state().mode);
  // The main agent and its subagents share one prompt queue, so their permission dialogs never overlap.
  const askPermission = serializeAsks((prompt, signal) => opts.ui.askPermission(prompt, signal));
  const nonce = () => harnessNonce(opts.session().id);
  const contextFor = (scope: "main" | "subagent") => async () =>
    buildContextText(await loadMemory(ctx.cwd, ctx.home), await environmentBlock(ctx.cwd, { shell: ctx.shell }), [
      ...(await contextExtras(ctx.ext, (skills) => skillListing(skills), { home: ctx.home, scope, bootstrap: opts.interactive })),
      nonceBlock(nonce()),
    ]);
  const contextText = contextFor("main");
  const beforeChange = () => ctx.ext.undo.beforeChange();
  const onAllowAlways = async (rule: string) => {
    // A rule saved from a messaging chat would outlive it and apply to every later session.
    if (ctx.origin === "channel") return;
    ctx.rules.allow.push(parseRule(rule));
    await addLocalAllowRule(ctx.localSettingsPath, rule);
  };
  // Set below: subagents add their spend to this agent's total.
  let agent: Agent | undefined;
  // Only project files: Memory and SkillManage also edit (under ~/.tropos), and no formatter should touch those.
  const afterWrite = (paths: string[], signal: AbortSignal) =>
    postWrite(ctx.ext, opts.toolContext.readState, paths.filter((p) => ctx.allowedDirs.some((dir) => isInside(p, dir))), signal);
  ctx.subagents.deps = {
    model: ctx.model,
    tools: ctx.tools,
    system: SYSTEM_PROMPT,
    config,
    // Without the role and stores: a subagent's saves to Tropos's stores ask through the shared queue, because
    // its tool results never reach the user as a learned notice.
    permissions: () => {
      const { role: _role, stores: _stores, ...rest } = permissions();
      return rest;
    },
    askPermission,
    contextText: contextFor("subagent"),
    nonce,
    onAllowAlways,
    recordCost: (cost) => agent?.addCost(cost),
    openTranscript: (name) =>
      SessionStore.createSubagent(ctx.home, { cwd: ctx.cwd, parentId: opts.session().id, agent: name, model: config().model, version: ctx.version }),
    hooks: opts.hooks,
    beforeChange,
    postWrite: afterWrite,
  };
  // The background review (Hermes' learning loop): interactive sessions only, never print mode.
  // The review writes skills to its own folder (~/.tropos/skills-learned), never over the user's.
  const learnedSkills = createSkillManageTool({ home: ctx.home, folder: LEARNED_SKILLS_DIR, ledger: ctx.ext.ledger, tracker: ctx.ext.reviewTracker });
  const learning = (opts.learn ?? opts.interactive)
    ? new LearningLoop({
        settings: () => ctx.settings.learning,
        initial: opts.counters?.initial,
        saveCounters: opts.counters?.save,
        notice: (text) => opts.ui.emit({ type: "notice", level: "info", text, learned: true }),
        runReview: async (_kind, prompt, history, signal) => {
          const result = await runReviewAgent({
            model: ctx.model,
            tools: ctx.tools,
            system: SYSTEM_PROMPT,
            config,
            permissions,
            hooks: opts.hooks,
            // Its own read-state and todos: the review's reads must not count for the main agent's write guard.
            toolContext: { ...opts.toolContext, readState: new ReadState(), todos: new MemoryTodoStore() },
            history,
            prompt,
            signal,
            overrides: { SkillManage: learnedSkills },
          });
          agent?.addCost(result.costUsd);
          return result;
        },
      })
    : undefined;
  if (learning) opts.onLearning?.(learning);
  const storeInputs = new Map<string, unknown>();

  agent = new Agent(
    {
      model: ctx.model,
      tools: ctx.tools,
      system: SYSTEM_PROMPT,
      config,
      permissions,
      askPermission,
      onAllowAlways,
      contextText,
      nonce,
      persist: (message) => opts.session().appendMessage(message),
      // Usage lives in its own event lines: extra fields on a stored message would be sent back to the API.
      recordUsage: ({ model, usage, costUsd }) =>
        void opts
          .session()
          .appendEvent("usage", { model, usage: { ...usage, ...(costUsd === undefined ? {} : { cost_usd: costUsd }) } })
          .catch(() => {}),
      toolContext: opts.toolContext,
      maxTurns: opts.maxTurns,
      emit: (event) => {
        // A save the agent made itself: say so once it is done, whoever approved it.
        if (event.type === "tool_start" && STORE_TOOL_NAMES.has(event.name)) storeInputs.set(event.id, event.input);
        if (event.type === "tool_end" && STORE_TOOL_NAMES.has(event.name)) {
          const input = storeInputs.get(event.id);
          storeInputs.delete(event.id);
          const text = event.status === "done" ? savedNotice(event.name, input) : undefined;
          if (text) opts.ui.emit({ type: "notice", level: "info", text, learned: true });
        }
        if (event.type === "tool_end" && event.name === "Identity" && event.status === "done") opts.onIdentityChange?.();
        if (learning) {
          if (event.type === "tool_end") learning.onToolEnd(event.name, event.status);
          // Timed against compaction; models without a known window (other providers) assume 128k.
          else if (event.type === "usage") learning.onUsage(event.contextTokens, flushWindow(config().model));
        }
        opts.ui.emit(event);
      },
      hooks: opts.hooks,
      beforeChange,
      postWrite: afterWrite,
      endTurn: (reason, messages) => learning?.afterTurn(reason, [...messages]),
      startTurn: () => {
        // A new turn wins over a review still running in the background.
        learning?.cancel();
        ctx.ext.undo.beginTurn();
        const undone = ctx.ext.undo.takeReminder()?.replace(/^<reminder>/, `<reminder nonce="${nonce()}">`) ?? null;
        return [opts.pending?.take() ?? null, undone].filter((t): t is string => t !== null);
      },
    },
    opts.history,
  );
  return agent;
}

/** Strips punctuation that ends a sentence from an `@path` token: "see @src/a.ts," means src/a.ts. */
function cleanToken(token: string): string {
  return token.replace(/[),.;:!?'"]+$/, "");
}

/**
 * The CommandIO for custom commands: `` !`cmd` `` goes through the Bash permission check (asking
 * through the UI when needed), and `@path` reads only allowed files no Read deny rule covers.
 */
export function commandIO(
  ctx: AppContext,
  mode: () => Mode,
  toolContext: Omit<ToolContext, "signal">,
  ui: Pick<AgentUi, "askPermission">,
  signal: AbortSignal,
  hooks?: HookRunner,
): CommandIO {
  const permissions = () => permissionContext(ctx, mode());
  return {
    async runShell(original) {
      let command = original;
      if (signal.aborted) return { ok: false, reason: "interrupted" };
      // Bash guard hooks see these commands too, and their answers count exactly as for a model's Bash call.
      let hookPermission: "allow" | "deny" | "ask" | undefined;
      if (hooks?.has("PreToolUse")) {
        const out = await hooks.run("PreToolUse", { tool_name: "Bash", tool_input: { command }, tool_use_id: "slash-command" }, "Bash", signal);
        const refusal = out.blocked ?? out.stop ?? (out.permission === "deny" ? (out.permissionReason ?? "denied by a hook") : undefined);
        if (refusal !== undefined) return { ok: false, reason: `a PreToolUse hook refused \`${command}\`: ${refusal}` };
        if (out.updatedInput !== undefined) {
          const rewritten = (out.updatedInput as { command?: unknown } | null)?.command;
          if (typeof rewritten !== "string" || !rewritten.trim()) return { ok: false, reason: `a PreToolUse hook rewrote \`${command}\` into something invalid` };
          command = rewritten;
        }
        // As in the agent: an allow can't vouch for a rewritten command; an ask always prompts.
        hookPermission = out.updatedInput !== undefined && out.permission === "allow" ? undefined : out.permission;
        if (signal.aborted) return { ok: false, reason: "interrupted" };
      }
      let decision = decide({ toolName: "Bash", kind: "exec", command, paths: [] }, permissions());
      if (decision.behavior === "deny") return { ok: false, reason: decision.reason };
      if (hookPermission === "allow" && decision.behavior === "ask") decision = { behavior: "allow" };
      if (hookPermission === "ask" && decision.behavior === "allow") decision = { behavior: "ask", reason: "a PreToolUse hook asked for confirmation" };
      if (decision.behavior === "ask") {
        const prompt: PermissionPrompt = {
          toolName: "Bash",
          kind: "exec",
          summary: command,
          input: { command },
          reason: decision.reason ?? "a slash command runs this",
        };
        const answer = await ui.askPermission(prompt, signal);
        if (answer.kind === "deny") return { ok: false, reason: `you declined \`${command}\`` };
        if (signal.aborted) return { ok: false, reason: "interrupted" };
      }
      const out = await bashTool.run({ command }, { ...toolContext, signal });
      const text = typeof out.content === "string" ? out.content : "";
      if (signal.aborted) return { ok: false, reason: "interrupted" };
      // A failing command's output still goes in (the user may want to discuss it); only a refusal stops.
      return { ok: true, output: text };
    },
    async readFile(token) {
      let path: string;
      try {
        path = resolveToolPath(cleanToken(token), toolContext.cwd());
      } catch {
        return null;
      }
      if (!ctx.allowedDirs.some((dir) => isInside(path, dir))) return null;
      if (decide({ toolName: "Read", kind: "read", paths: [path] }, permissions()).behavior === "deny") return null;
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size > MAX_EXTENSION_BYTES) return null;
      const content = await readFile(path, "utf8").catch(() => null);
      return content === null ? null : { path, content };
    },
  };
}

/** Expands `/name args` for a custom command or a user-invocable skill into the text the model receives. */
export async function expandSlash(ctx: AppContext, name: string, args: string, io: CommandIO): Promise<CommandExpansion> {
  const command = ctx.ext.commands.find((c) => c.name === name);
  if (command) {
    const expanded = await expandCommand(command, args, io);
    if (!expanded.ok) return expanded;
    let prompt = commandMessage(name, expanded.prompt, args, command.source);
    if (command.agent) prompt += `\n\nRun this with the Agent tool (subagent_type: "${command.agent}") and report its result.`;
    // A repo's command may pick among Anthropic models only, like repo settings.
    const model = command.model && (command.source !== "project" || isAnthropicModelId(command.model)) ? command.model : undefined;
    return { ok: true, prompt, model };
  }
  const skill = ctx.ext.skills.find((s) => s.name === name && s.userInvocable);
  if (skill) return { ok: true, prompt: await renderSkill(skill, args) };
  return { ok: false, reason: `Unknown command /${name}.` };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const firstLine = (text: string) => text.split("\n")[0] ?? "";

/** Structured data for /skills, /agents, /hooks, /mcp, /plugins and /memory, rendered as panels. */
export async function extensionPanel(ctx: AppContext, what: ListTopic): Promise<PanelData> {
  const ext = ctx.ext;
  switch (what) {
    case "skills": {
      const bySource = (source: string) =>
        ext.skills
          .filter((s) => (source === "plugin" ? s.source === "plugin" : s.source === source))
          .map((s) => ({
            key: s.name,
            label: s.name,
            hint: firstLine(s.description),
            aside: [s.userInvocable ? `/${s.name}` : "", s.modelInvocable ? "" : "you only"].filter(Boolean).join(" · ") || undefined,
            detail: [s.description, ...(s.whenToUse ? [`When: ${s.whenToUse}`] : []), s.path],
          }));
      return {
        title: "Skills",
        subtitle: plural(ext.skills.length, "skill"),
        sections: [
          { title: "Yours (~/.tropos/skills)", items: bySource("user") },
          { title: "Learned on its own (~/.tropos/skills-learned)", items: bySource("learned") },
          { title: "This project", items: bySource("project") },
          { title: "Plugins", items: bySource("plugin") },
        ].filter((section) => section.items.length > 0),
        empty: "No skills yet. Ask me to make one, or I'll write them as I learn what you need.",
      };
    }
    case "agents":
      return {
        title: "Agents",
        subtitle: `${plural(ext.agents.length, "agent")} the Agent tool can start`,
        sections: (["builtin", "user", "project", "plugin"] as const)
          .map((source) => ({
            title: { builtin: "Built-in", user: "Yours (~/.tropos/agents)", project: "This project", plugin: "Plugins" }[source],
            items: ext.agents
              .filter((a) => a.source === source)
              .map((a) => ({
                key: a.name,
                label: agentLabel(a),
                hint: firstLine(a.description),
                aside: a.model,
                detail: [a.description, `Tools: ${a.tools ? a.tools.join(", ") : "all"}`, ...(a.path ? [a.path] : [])],
              })),
          }))
          .filter((section) => section.items.length > 0),
      };
    case "hooks": {
      const items = (from: string, hooks: Extensions["hookConfig"]["hooks"]) =>
        HOOK_EVENTS.flatMap((event) =>
          (hooks[event] ?? []).flatMap((m, mi) =>
            m.hooks.map((h, hi) => ({
              key: `${from}:${event}:${mi}:${hi}`,
              label: `${event}${m.matcher ? ` [${m.matcher}]` : ""}`,
              hint: firstLine(h.command),
              detail: [h.command, `Timeout: ${h.timeout ?? 60}s`],
            })),
          ),
        );
      return {
        title: "Hooks",
        sections: [
          { title: "Settings (~/.tropos/settings.json)", items: items("settings", ext.hookConfig.hooks) },
          ...(ext.hookConfig.plugins ?? []).map((p) => ({ title: `Plugin ${p.name}`, items: items(p.name, p.hooks) })),
        ].filter((section) => section.items.length > 0),
        empty: "No hooks. Add them in the dashboard (tcode dashboard → Extensions).",
      };
    }
    case "mcp": {
      const status = ext.mcp?.status() ?? [];
      return {
        title: "MCP servers",
        subtitle: plural(status.length, "server"),
        sections: [
          {
            items: status.map((s) => ({
              key: s.name,
              label: s.name,
              hint: s.state === "connected" ? `connected · ${plural(s.tools, "tool")}` : s.state,
              aside: s.type,
              status: s.state === "connected" ? (s.error ? ("warn" as const) : ("ok" as const)) : s.state === "disabled" ? ("off" as const) : ("error" as const),
              detail: s.error ? [s.error] : [`${plural(s.tools, "tool")}, named mcp__${s.name}__<tool>`],
            })),
          },
        ].filter((section) => section.items.length > 0),
        empty: "No MCP servers. Ask me to add one, or add it in the dashboard (tcode dashboard → Extensions).",
      };
    }
    case "plugins":
      return {
        title: "Plugins",
        subtitle: plural(ext.plugins.length, "plugin"),
        sections: [
          {
            items: ext.plugins.map((p) => ({
              key: p.name,
              label: p.name,
              hint: p.description,
              aside: p.version,
              status: p.enabled ? ("ok" as const) : ("off" as const),
              detail: [p.root, p.enabled ? "Enabled" : 'Disabled ("disabledPlugins" in settings)'],
            })),
          },
        ].filter((section) => section.items.length > 0),
        empty: "No plugins. Put plugin folders in ~/.tropos/plugins/.",
      };
    case "memory": {
      if (!ext.notes) return { title: "Memory", sections: [], empty: "Memory is off. Turn it on in the dashboard's settings (tcode dashboard)." };
      const sections: PanelSection[] = [];
      for (const target of ["memory", "user"] as const) {
        const entries = await ext.notes.entries(target);
        sections.push({
          title: `${notesLabel(target)} ${usageHeader(notesSize(entries), MEMORY_LIMITS[target])}`,
          items: entries.map((e, i) => ({ key: `${target}:${i}`, label: firstLine(e), detail: e.split("\n") })),
        });
      }
      return { title: "Memory", subtitle: ext.notes.dir, sections, empty: "No notes yet." };
    }
    case "learned": {
      const entries = await ext.ledger.list(LEARNED_PANEL_LIMIT);
      const by = { agent: "saved while we talked", review: "learned on its own", user: "you" } as const;
      return {
        title: "Learned",
        subtitle: "Notes, skills and identity changes, newest first · /learned undo reverts the latest",
        sections: [
          {
            items: entries.map((e) => ({
              key: e.id,
              label: `${e.kind}: ${e.summary}`,
              hint: e.action === "undo" ? "undo" : by[e.actor],
              aside: e.ts.slice(0, 16).replace("T", " "),
              status: e.undone ? ("off" as const) : e.action === "undo" ? ("warn" as const) : ("ok" as const),
              detail: [`${e.action} by ${e.actor}${e.undone ? " (undone)" : ""}`, e.path, e.ts],
            })),
          },
        ].filter((section) => section.items.length > 0),
        empty: "Nothing learned yet. Notes, skills and identity changes show up here, with undo.",
      };
    }
  }
}

/** Name and emoji for headers; nothing when unset or unreadable. */
async function headerIdentity(home: string): Promise<{ name?: string; emoji?: string }> {
  const { name, emoji } = await loadIdentity(home).catch(() => ({}) as { name?: string; emoji?: string });
  return { ...(name ? { name } : {}), ...(emoji ? { emoji } : {}) };
}

/** Ledger entries the /learned panel shows. */
const LEARNED_PANEL_LIMIT = 50;

const INPUT_HISTORY_LIMIT = 200;

async function loadInputHistory(path: string, cwd: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { text?: unknown; cwd?: unknown };
        return entry.cwd === cwd && typeof entry.text === "string" ? [entry.text] : [];
      } catch {
        return [];
      }
    })
    .slice(-INPUT_HISTORY_LIMIT);
}

export async function createRuntime(
  ctx: AppContext,
  init: {
    session: SessionStore;
    history: MessageParam[];
    mode: Mode;
    modes: Mode[];
    theme: Theme;
    initialPrompt?: string;
    startWithPicker?: boolean;
    /** SessionStart's source: resume when the session was continued or resumed. */
    source?: "startup" | "resume";
    /** False for sessions from a messaging channel: no learning review, no first-run identity note. Default true. */
    interactive?: boolean;
    /** Runs the background review; defaults to `interactive`. */
    learn?: boolean;
    /**
     * False when other sessions share ctx.ext (the gateway's chats): shutting this one down must not close the
     * MCP servers, language servers and search index under the others. Default true.
     */
    ownsExtensions?: boolean;
  },
): Promise<Runtime> {
  let session = init.session;
  let history = init.history;
  let state = { model: ctx.settings.model, effort: ctx.settings.effort, mode: init.mode };
  let turnModel: string | undefined;
  const toolContext = createToolContext(ctx);
  const historyPath = join(ctx.home, "history.jsonl");
  const inputs = await loadInputHistory(historyPath, ctx.cwd);
  const hooks = sessionHooks(ctx, () => session, () => state.mode);
  let pendingContext: string | null = null;
  const pending = {
    take: () => {
      const text = pendingContext;
      pendingContext = null;
      return text;
    },
  };
  const agentState = () => (turnModel ? { ...state, model: turnModel } : state);
  let learning: LearningLoop | undefined;
  let identity = await headerIdentity(ctx.home);
  // Saves can land close together: only the newest read may win.
  let identityReads = 0;
  const refreshIdentity = () => {
    const read = ++identityReads;
    void headerIdentity(ctx.home).then((id) => {
      if (read === identityReads) identity = id;
    });
  };
  // Counters carry across sessions in this project: loaded here and again after /clear and resume.
  let counters = await loadCounters(ctx.home, ctx.cwd);
  // Saves go out in order, so an older value never lands last.
  let savingCounters: Promise<void> = Promise.resolve();
  // Only the live loop writes the file; a detached loop's final review must not overwrite the next session's counts.
  let generation = 0;
  // Loops of earlier sessions (/clear, resume) still running their final review.
  const detached = new Set<LearningLoop>();
  const loops = () => [...detached, ...(learning ? [learning] : [])];
  const detachLearning = async () => {
    const old = learning;
    learning = undefined;
    generation++;
    if (old) {
      detached.add(old);
      // Not awaited: /clear and resume return at once while the old session's last review runs.
      void old.finish(FINAL_REVIEW_TIMEOUT_MS).finally(() => detached.delete(old));
    }
    await savingCounters;
    counters = await loadCounters(ctx.home, ctx.cwd);
  };

  return {
    version: ctx.version,
    cwd: ctx.cwd,
    theme: init.theme,
    modes: init.modes,
    initialPrompt: init.initialPrompt,
    startWithPicker: init.startWithPicker,
    providers: ctx.providers,
    extraCommands: extraCommands(ctx.ext),
    state: () => state,
    setMode: (mode) => {
      state = { ...state, mode };
      void session.appendEvent("mode", mode).catch(() => {});
    },
    setModel: (model) => {
      state = { ...state, model };
      void session.appendEvent("model", model).catch(() => {});
    },
    setEffort: (effort) => {
      state = { ...state, effort };
      void session.appendEvent("effort", effort).catch(() => {});
    },
    setTurnModel: (model) => {
      turnModel = model;
    },
    newAgent: (ui) => {
      // A new agent over the same session (/clear and resume detach the old loop first) ends its review.
      learning?.cancel();
      const mine = ++generation;
      return makeAgent(ctx, {
        session: () => session,
        history,
        state: agentState,
        ui,
        toolContext,
        hooks,
        pending,
        interactive: init.interactive ?? true,
        learn: init.learn,
        onLearning: (loop) => {
          learning = loop;
        },
        counters: {
          initial: learning?.counters ?? counters,
          save: (c) => {
            if (mine !== generation) return;
            savingCounters = savingCounters.then(() => saveCounters(ctx.home, ctx.cwd, c)).catch(() => {});
          },
        },
        onIdentityChange: refreshIdentity,
      });
    },
    history: () => history,
    sessionId: () => session.id,
    clear: async () => {
      await detachLearning();
      ctx.ext.tracker.reset();
      await sessionEnd(hooks, "clear");
      session = await SessionStore.create(ctx.home, { cwd: ctx.cwd, model: state.model, version: ctx.version });
      history = [];
      pendingContext = await sessionStart(hooks, "clear", () => {}, harnessNonce(session.id)).catch(() => null);
    },
    sessions: () => listSessions(ctx.home, ctx.cwd),
    resume: async (id) => {
      await detachLearning();
      ctx.ext.tracker.reset();
      const opened = await SessionStore.open(ctx.home, ctx.cwd, id);
      session = opened.store;
      history = opened.messages;
      pendingContext = await sessionStart(hooks, "resume", () => {}, harnessNonce(session.id)).catch(() => null);
    },
    inputHistory: () => inputs,
    recordInput: (text) => {
      // A chat's messages are not the terminal's ↑ history.
      if (init.interactive === false) return;
      inputs.push(text);
      void mkdir(ctx.home, { recursive: true })
        .then(() => appendFile(historyPath, `${JSON.stringify({ text, cwd: ctx.cwd, ts: new Date().toISOString() })}\n`, { mode: 0o600 }))
        .catch(() => {});
    },
    expandCommand: (name, args, ui, signal) => expandSlash(ctx, name, args, commandIO(ctx, () => state.mode, toolContext, ui, signal, hooks)),
    panel: (what) => extensionPanel(ctx, what),
    modelPrefs: ctx.modelPrefs,
    undo: () => ctx.ext.undo.undo(),
    redo: () => ctx.ext.undo.redo(),
    undoLearned: async (id) => {
      // An undo racing the review's own write could be overwritten by it.
      if (loops().some((l) => l.running)) return { ok: false, reason: "The background review is saving; try again in a moment." };
      const out = await ctx.ext.ledger.undo(id);
      return out.ok ? { ok: true, summary: `${out.entry.kind}: ${out.entry.summary}` } : out;
    },
    identity: () => identity,
    start: async (notice) => {
      pendingContext = await sessionStart(hooks, init.source ?? "startup", notice, harnessNonce(session.id)).catch(() => null);
      // Archive learned skills nobody used for a month (at most once a week; never deletes).
      if (ctx.settings.learning.curator && (init.interactive ?? true)) {
        void runCurator(ctx.home, { ledger: ctx.ext.ledger, skillsDir: join(ctx.home, LEARNED_SKILLS_DIR) })
          .then(({ archived }) => {
            if (archived.length > 0) {
              notice("info", `Archived ${archived.length} learned skill${archived.length === 1 ? "" : "s"} unused for 30 days: ${archived.join(", ")} (in ${join(ctx.home, LEARNED_SKILLS_DIR, ".archive")})`);
            }
          })
          .catch(() => {});
      }
    },
    finalReviewDue: () => loops().some((l) => l.running || l.finalDue),
    skipFinalReview: () => {
      for (const l of loops()) l.cancel();
    },
    shutdown: async (opts) => {
      if (opts?.finalReview ?? true) {
        await Promise.all(loops().map((l) => l.finish(FINAL_REVIEW_TIMEOUT_MS)));
      } else {
        const all = loops();
        for (const l of all) l.cancel();
        // A review that ignores the abort must not hold the session's end: the same bound as a final review's.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.all(all.map((l) => l.whenIdle())), new Promise<void>((resolve) => (timer = setTimeout(resolve, FINAL_REVIEW_TIMEOUT_MS)))]);
        clearTimeout(timer);
      }
      await savingCounters;
      await sessionEnd(hooks, "exit");
      if (init.ownsExtensions === false) return;
      ctx.ext.searchIndex?.close();
      await Promise.all([ctx.ext.mcp?.close(), ctx.ext.lsp?.close()]);
    },
  };
}
