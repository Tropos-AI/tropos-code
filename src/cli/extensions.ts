// src/cli/extensions.ts
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { runSubagent } from "../agent/subagent";
import { isSpecialist, loadAllAgents, specialistRoster } from "../agents/specialists";
import { runSpecialist, SpecialistSlots, type SpecialistDeps } from "../agents/delegate";
import { recordRun } from "../agents/runs";
import { HOOK_EVENTS, type HooksSetting, type Settings } from "../config/settings";
import { createAgentManageTool } from "../extensions/agent-manage";
import { type AgentDefinition } from "../extensions/agents";
import { loadCommands, type CustomCommand } from "../extensions/commands";
import { loadPlugins, pluginRoots, type LoadedPlugin } from "../extensions/plugins";
import { loadSkills, type Skill } from "../extensions/skills";
import { extensionDirs } from "../extensions/sources";
import { Formatters } from "../format/formatters";
import { HookRunner, type HookRunnerConfig } from "../hooks/runner";
import { LspManager } from "../lsp/manager";
import { McpManager } from "../mcp/manager";
import { bootstrapContext, bootstrapPending, createIdentityTool, identityContext, loadBootstrap, loadIdentity } from "../context/identity";
import { Ledger } from "../learning/ledger";
import { SkillTracker } from "../learning/skill-tracker";
import { createDailyNoteTool, DailyNotes, dailyNotesContext } from "../memory/daily";
import { createMemoryTool } from "../memory/memory-tool";
import { NotesStore, notesContext } from "../memory/notes";
import { SearchIndex } from "../memory/search-index";
import { createSessionSearchTool } from "../memory/session-search";
import { createSkillManageTool } from "../memory/skill-manage";
import { SnapshotStore } from "../snapshots/store";
import { UndoManager } from "../snapshots/undo";
import { createAgentTool } from "../tools/agent/agent-tool";
import type { ReadState } from "../tools/read-state";
import { createSkillTool } from "../tools/skill/skill";
import type { AnyTool } from "../tools/types";
import { webFetchTool } from "../tools/webfetch/webfetch";
import { RESERVED_COMMANDS, type ExtraCommand } from "../ui/commands";
import { VERSION } from "../version";

/** Everything phase-2 extensions contribute to a session, loaded once at startup (the tool list must stay fixed). */
export interface Extensions {
  plugins: LoadedPlugin[];
  commands: CustomCommand[];
  skills: Skill[];
  /** Subagent definitions; refreshed in place by reloadAgents. */
  agents: AgentDefinition[];
  /** Re-reads the agent folders into `agents` (after AgentManage, or when the Agent tool meets an unknown name). */
  reloadAgents(): Promise<void>;
  /** Re-reads commands, skills and agents, replacing the contents of `commands`, `skills` and `agents` in place. */
  reload(): Promise<void>;
  /** Settings hooks plus enabled plugins' hooks. */
  hookConfig: HookRunnerConfig;
  mcp: McpManager | null;
  notes: NotesStore | null;
  /** Append-only project notes per day (null when memory is off). */
  daily: DailyNotes | null;
  /** Every change to learned files (notes, skills, identity), for /learned and undo. */
  ledger: Ledger;
  /** Skills loaded or created in this session: SkillManage patches only those (read before write). */
  tracker: SkillTracker;
  /** The same, for the learning review, kept apart so its reads never unlock a skill for the main agent. */
  reviewTracker: SkillTracker;
  /** The full-text index SessionSearch uses; null in tests or where SQLite/FTS5 is unavailable (it then scans). */
  searchIndex: SearchIndex | null;
  formatters: Formatters | null;
  lsp: LspManager | null;
  undo: UndoManager;
  /**
   * Set once the agent writes a file formatters or language servers load code from: both stay off for
   * the rest of the session, so an approved file edit can't turn into running code.
   */
  codeConfigWritten?: string;
  /** Startup notices: files that didn't load, servers that didn't start. */
  warnings: string[];
}

export interface LoadExtensionsOptions {
  cwd: string;
  home: string;
  settings: Settings;
  env: NodeJS.ProcessEnv;
  /** Tests skip connecting to MCP servers and opening the snapshot store. */
  connect?: boolean;
}

function hasHooks(hooks: HooksSetting): boolean {
  return HOOK_EVENTS.some((event) => (hooks[event]?.length ?? 0) > 0);
}

export async function loadExtensions(opts: LoadExtensionsOptions): Promise<Extensions> {
  const { cwd, home, settings } = opts;
  const warnings: string[] = [];
  const loaded = await loadPlugins(home, settings.disabledPlugins);
  warnings.push(...loaded.warnings);
  const plugins = loaded.plugins;
  const roots = pluginRoots(plugins);
  const dirs = (kind: "commands" | "skills" | "agents") => extensionDirs(kind, { cwd, home, plugins: roots });

  const readAll = async () => {
    const [commands, skills, agents] = await Promise.all([
      loadCommands(dirs("commands"), RESERVED_COMMANDS),
      loadSkills(dirs("skills")),
      loadAllAgents(dirs("agents"), home),
    ]);
    // A skill named like a built-in or a custom command can still be loaded by the model, just not typed.
    const commandNames = new Set([...RESERVED_COMMANDS, ...commands.commands.map((c) => c.name)]);
    const typedSkills = skills.skills.map((s) => (s.userInvocable && commandNames.has(s.name) ? { ...s, userInvocable: false } : s));
    return {
      commands: commands.commands,
      skills: typedSkills,
      agents: agents.agents,
      warnings: [...commands.warnings, ...skills.warnings, ...agents.warnings],
    };
  };
  const first = await readAll();
  warnings.push(...first.warnings);

  const enabled = plugins.filter((p) => p.enabled);
  const hookConfig: HookRunnerConfig = {
    hooks: settings.hooks,
    plugins: enabled.filter((p) => hasHooks(p.hooks)).map((p) => ({ name: p.name, root: p.root, hooks: p.hooks })),
  };

  const servers = { ...Object.fromEntries(enabled.flatMap((p) => Object.entries(p.mcpServers))), ...settings.mcpServers };
  let mcp: McpManager | null = null;
  if (Object.keys(servers).length > 0 && opts.connect !== false) {
    mcp = new McpManager(servers, opts.env, { clientVersion: VERSION });
    await mcp.start();
    for (const s of mcp.status()) {
      if (s.state === "failed") warnings.push(`MCP server ${s.name} didn't start: ${s.error ?? "unknown error"}`);
      else if (s.error) warnings.push(`MCP server ${s.name}: ${s.error}`);
    }
  }

  let snapshots: SnapshotStore | null = null;
  if (settings.snapshots && opts.connect !== false) {
    snapshots = await SnapshotStore.open(home, cwd).catch(() => null);
    void snapshots?.prune();
  }

  const ledger = new Ledger(home);
  const daily = settings.memory
    ? new DailyNotes(home, cwd, {
        onChange: (e) =>
          ledger.record({ actor: e.actor, kind: "daily", path: e.path, action: "append", summary: "daily note", before: e.before, after: e.after }).then(() => {}),
      })
    : null;

  const commandList = first.commands;
  const skillList = first.skills;
  const agentList = first.agents;
  const reload = async () => {
    const fresh = await readAll();
    commandList.splice(0, commandList.length, ...fresh.commands);
    skillList.splice(0, skillList.length, ...fresh.skills);
    agentList.splice(0, agentList.length, ...fresh.agents);
  };
  const reloadAgents = async () => {
    const fresh = await loadAllAgents(dirs("agents"), home);
    agentList.splice(0, agentList.length, ...fresh.agents);
  };

  return {
    plugins,
    commands: commandList,
    skills: skillList,
    agents: agentList,
    reloadAgents,
    reload,
    hookConfig,
    mcp,
    notes: settings.memory ? new NotesStore(home, { ledger }) : null,
    daily,
    ledger,
    tracker: new SkillTracker(),
    reviewTracker: new SkillTracker(),
    searchIndex: opts.connect !== false ? SearchIndex.open(home) : null,
    formatters: settings.formatter === false ? null : new Formatters(settings.formatter, cwd),
    lsp: settings.lsp === false ? null : new LspManager(settings.lsp, cwd),
    undo: new UndoManager(snapshots),
    warnings,
  };
}

/** A hook runner, or undefined when no settings or plugin hook exists (the loop then skips hook work). */
export function createHookRunner(
  ext: Extensions,
  base: { sessionId(): string; transcriptPath(): string; cwd: string; mode(): string; env: NodeJS.ProcessEnv; shell: string },
): HookRunner | undefined {
  const any = hasHooks(ext.hookConfig.hooks) || (ext.hookConfig.plugins?.length ?? 0) > 0;
  return any ? new HookRunner(ext.hookConfig, base) : undefined;
}

/** Where the Agent tool finds the running session's model, prompts and permissions; set by makeAgent. */
export interface SubagentHolder {
  deps?: SpecialistDeps;
  /** Specialist work that outlives its run (their own learning reviews); the runtime awaits it at shutdown. */
  background?: Set<Promise<void>>;
}

/**
 * The session's tools, in a fixed order: base tools, WebFetch, Skill,
 * Agent, Memory and DailyNote (when memory is on), SessionSearch, SkillManage, AgentManage, Identity, then MCP tools.
 */
export function sessionTools(
  base: AnyTool[],
  ext: Extensions,
  opts: { home: string; cwd: string; holder: SubagentHolder; sessionId(): string },
): AnyTool[] {
  const tools: AnyTool[] = [...base, webFetchTool as AnyTool];
  // Always present: a skill written later in the session can still be loaded (the tool reloads on an unknown name).
  tools.push(createSkillTool(ext.skills, { home: opts.home, tracker: ext.tracker, reviewTracker: ext.reviewTracker, reload: ext.reload }));
  // One set of slots per session: the cap of parallel specialists counts across all Agent calls.
  const slots = new SpecialistSlots();
  tools.push(
    createAgentTool(ext.agents, (def, prompt, ctx, task) => {
      const deps = opts.holder.deps;
      if (!deps) return Promise.resolve({ content: "Subagents aren't available yet in this session.", isError: true });
      if (isSpecialist(def)) return runSpecialist(def, prompt, task, deps, ctx, slots);
      let logged: Promise<void> = Promise.resolve();
      return runSubagent(def, prompt, deps, ctx, (run) => {
        logged = recordRun(opts.home, {
          ts: new Date().toISOString(),
          agent: def.name,
          specialist: false,
          task,
          ok: run.ok,
          result: run.report,
          durationMs: run.durationMs,
          ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
          cwd: ctx.cwd(),
        }).catch(() => {});
      }).then(async (out) => {
        await logged;
        return out;
      });
    }, ext.reloadAgents),
  );
  if (ext.notes) tools.push(createMemoryTool(ext.notes));
  if (ext.daily) tools.push(createDailyNoteTool(ext.daily));
  tools.push(createSessionSearchTool({ home: opts.home, cwd: opts.cwd, currentSessionId: opts.sessionId, index: ext.searchIndex }));
  tools.push(createSkillManageTool({ home: opts.home, ledger: ext.ledger, tracker: ext.tracker }));
  tools.push(createAgentManageTool({ home: opts.home, ledger: ext.ledger, onChange: ext.reloadAgents }));
  tools.push(
    createIdentityTool({
      home: opts.home,
      onChange: (e) =>
        ext.ledger.record({ actor: e.actor, kind: "identity", path: e.path, action: "write", summary: e.summary, before: e.before, after: e.after }).then(() => {}),
    }),
  );
  if (ext.mcp) tools.push(...ext.mcp.tools());
  return tools;
}

/**
 * The context-block extras. The main session gets the identity (and, on the first interactive run, the
 * bootstrap note), the skill listing, both note stores and recent daily notes. A subagent gets only what
 * helps the task: the skill listing and the agent's own notes, never the user profile, the soul or the
 * daily notes.
 */
export async function contextExtras(
  ext: Extensions,
  listing: (skills: Skill[]) => string,
  opts: { home: string; scope: "main" | "subagent"; bootstrap?: boolean; reminder?: string; specialists?: boolean },
): Promise<string[]> {
  const skills = listing(ext.skills);
  if (opts.scope === "subagent") {
    return [skills, ext.notes ? await notesContext(ext.notes, { targets: ["memory"] }).catch(() => "") : ""];
  }
  const identity = identityContext(await loadIdentity(opts.home).catch(() => ({})));
  const pending = opts.bootstrap && (await bootstrapPending(opts.home).catch(() => false));
  const bootText = pending ? await loadBootstrap(opts.home) : null;
  const bootstrap = bootText === null ? "" : bootstrapContext(bootText);
  return [
    identity,
    bootstrap,
    ...(opts.specialists ? [specialistRoster(ext.agents)] : []),
    skills,
    ext.notes ? await notesContext(ext.notes).catch(() => "") : "",
    ext.daily ? await dailyNotesContext(ext.daily).catch(() => "") : "",
    ...(opts.reminder ? [opts.reminder] : []),
  ];
}

/**
 * Plain source and document types: a write to one of these leaves formatters and language servers on.
 * Anything else (JSON, YAML, TOML, dotfiles, unknown types) may be a config they load code from, and a
 * list of config names would always miss one (prettier also reads package.yaml, tsconfig "extends" any
 * name...), so those fail closed.
 */
const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro",
  ".css", ".scss", ".sass", ".less", ".html", ".htm", ".md", ".mdx", ".txt",
  ".py", ".pyi", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh",
]);
/** Source-typed names the tools still execute: JS configs, Yarn PnP loaders, Cargo build scripts. */
const CODE_FILE = /^(?:.*\.config\.[cm]?[jt]s|\.prettierrc.*|\.pnp\..*|build\.rs)$/i;
/** Folders whose contents those tools load: dependencies, Yarn's cache and releases, virtualenvs, Cargo config. */
const CODE_DIRS = new Set(["node_modules", ".yarn", ".cargo", ".venv", "venv", "site-packages"]);

function mayLoadCodeAt(path: string): boolean {
  const parts = path.split(/[\\/]/).map((part) => part.toLowerCase());
  const name = parts.at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  return !SOURCE_EXT.has(ext) || CODE_FILE.test(name) || parts.some((part) => CODE_DIRS.has(part));
}

/**
 * True when formatters or language servers might load code from this file, so writing it switches them
 * off. Checked on the path as given and as resolved, case-insensitively (macOS and Windows fold case).
 */
export function isCodeConfig(path: string): boolean {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // a file that doesn't exist yet: its name is all there is to check
  }
  return mayLoadCodeAt(path) || mayLoadCodeAt(real);
}

/**
 * After a successful Write/Edit: run the formatter, refresh read-state if it changed the file (so the
 * next Edit isn't refused as stale), then collect language-server errors for the new content.
 */
export async function postWrite(ext: Extensions, readState: ReadState, paths: string[], signal: AbortSignal): Promise<string | null> {
  if ((!ext.formatters && !ext.lsp) || paths.length === 0) return null;
  if (ext.codeConfigWritten) return null;
  const config = paths.find(isCodeConfig);
  if (config) {
    ext.codeConfigWritten = config;
    return `(formatters and language servers are off for the rest of this session: ${config} is not a plain source file, and they may load code from it)`;
  }
  const notes: string[] = [];
  for (const path of paths) {
    const formatted = await ext.formatters?.format(path, signal).catch(() => null);
    if (formatted && "error" in formatted) notes.push(`(formatter ${formatted.name} failed: ${formatted.error})`);
    else if (formatted?.changed) {
      notes.push(`(formatted with ${formatted.name}: the file on disk may differ from what you wrote)`);
      const info = await stat(path).catch(() => null);
      if (info) readState.record(path, info.mtimeMs);
    }
    if (ext.lsp) {
      const content = await Bun.file(path).text().catch(() => null);
      const diagnostics = content === null ? null : await ext.lsp.diagnostics(path, content, signal);
      if (diagnostics) notes.push(diagnostics);
    }
  }
  return notes.length === 0 ? null : notes.join("\n");
}

/** Custom commands and user-invocable skills, for /help, completion and dispatch. */
export function extraCommands(ext: Extensions): ExtraCommand[] {
  const commands = ext.commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
  const skills = ext.skills
    .filter((s) => s.userInvocable)
    .map((s) => ({ name: s.name, description: `(skill) ${s.description.split("\n")[0]!.slice(0, 100)}` }));
  return [...commands, ...skills].sort((a, b) => a.name.localeCompare(b.name));
}
