import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "../agent/agent";
import type { Model } from "../api/model";
import type { Effort, Mode } from "../config/constants";
import { addLocalAllowRule, type Settings } from "../config/settings";
import { environmentBlock } from "../context/environment";
import { loadMemory } from "../context/memory";
import { SYSTEM_PROMPT, buildContextText } from "../context/system-prompt";
import type { PermissionRules } from "../permissions/engine";
import { parseRule } from "../permissions/rules";
import { SessionStore, listSessions, type MessageParam } from "../session/store";
import { JobTable } from "../tools/bash/jobs";
import { ReadState } from "../tools/read-state";
import { MemoryTodoStore } from "../tools/todo/todo";
import type { AnyTool, ToolContext } from "../tools/types";
import type { AgentUi, Runtime } from "../ui/runtime";
import type { Theme } from "../ui/theme";

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
  shell: string;
  localSettingsPath: string;
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
  };
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
  },
): Agent {
  return new Agent(
    {
      model: ctx.model,
      tools: ctx.tools,
      system: SYSTEM_PROMPT,
      config: () => ({ model: opts.state().model, effort: opts.state().effort, refusalFallback: ctx.settings.refusalFallback }),
      permissions: () => ({ mode: opts.state().mode, rules: ctx.rules, cwd: ctx.cwd, home: homedir(), allowedDirs: ctx.allowedDirs }),
      askPermission: (prompt, signal) => opts.ui.askPermission(prompt, signal),
      onAllowAlways: async (rule) => {
        ctx.rules.allow.push(parseRule(rule));
        await addLocalAllowRule(ctx.localSettingsPath, rule);
      },
      contextText: async () =>
        buildContextText(await loadMemory(ctx.cwd, ctx.home), await environmentBlock(ctx.cwd, { shell: ctx.shell })),
      persist: (message) => opts.session().appendMessage(message),
      toolContext: opts.toolContext,
      maxTurns: opts.maxTurns,
      emit: (event) => opts.ui.emit(event),
    },
    opts.history,
  );
}

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
  init: { session: SessionStore; history: MessageParam[]; mode: Mode; modes: Mode[]; theme: Theme; initialPrompt?: string; startWithPicker?: boolean },
): Promise<Runtime> {
  let session = init.session;
  let history = init.history;
  let state = { model: ctx.settings.model, effort: ctx.settings.effort, mode: init.mode };
  const toolContext = createToolContext(ctx);
  const historyPath = join(ctx.home, "history.jsonl");
  const inputs = await loadInputHistory(historyPath, ctx.cwd);

  return {
    version: ctx.version,
    cwd: ctx.cwd,
    theme: init.theme,
    modes: init.modes,
    initialPrompt: init.initialPrompt,
    startWithPicker: init.startWithPicker,
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
    newAgent: (ui) => makeAgent(ctx, { session: () => session, history, state: () => state, ui, toolContext }),
    history: () => history,
    clear: async () => {
      session = await SessionStore.create(ctx.home, { cwd: ctx.cwd, model: state.model, version: ctx.version });
      history = [];
    },
    sessions: () => listSessions(ctx.home, ctx.cwd),
    resume: async (id) => {
      const opened = await SessionStore.open(ctx.home, ctx.cwd, id);
      session = opened.store;
      history = opened.messages;
    },
    inputHistory: () => inputs,
    recordInput: (text) => {
      inputs.push(text);
      void mkdir(ctx.home, { recursive: true })
        .then(() => appendFile(historyPath, `${JSON.stringify({ text, cwd: ctx.cwd, ts: new Date().toISOString() })}\n`, { mode: 0o600 }))
        .catch(() => {});
    },
  };
}
