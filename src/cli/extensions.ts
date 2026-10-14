// src/cli/extensions.ts
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { runSubagent, type SubagentDeps } from "../agent/subagent";
import { HOOK_EVENTS, type HooksSetting, type Settings } from "../config/settings";
import { loadAgents, type AgentDefinition } from "../extensions/agents";
import { loadCommands, type CustomCommand } from "../extensions/commands";
import { loadPlugins, pluginRoots, type LoadedPlugin } from "../extensions/plugins";
import { loadSkills, type Skill } from "../extensions/skills";
import { extensionDirs } from "../extensions/sources";
import { Formatters } from "../format/formatters";
import { HookRunner, type HookRunnerConfig } from "../hooks/runner";
import { LspManager } from "../lsp/manager";
import { McpManager } from "../mcp/manager";
import { createMemoryTool } from "../memory/memory-tool";
import { NotesStore, notesContext } from "../memory/notes";
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
  agents: AgentDefinition[];
  /** Settings hooks plus enabled plugins' hooks. */
  hookConfig: HookRunnerConfig;
  mcp: McpManager | null;
  notes: NotesStore | null;
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

  const [commands, skills, agents] = await Promise.all([
    loadCommands(dirs("commands"), RESERVED_COMMANDS),
    loadSkills(dirs("skills")),
    loadAgents(dirs("agents")),
  ]);
  warnings.push(...commands.warnings, ...skills.warnings, ...agents.warnings);
  // A skill named like a built-in or a custom command can still be loaded by the model, just not typed.
  const commandNames = new Set([...RESERVED_COMMANDS, ...commands.commands.map((c) => c.name)]);
  const typedSkills = skills.skills.map((s) => (s.userInvocable && commandNames.has(s.name) ? { ...s, userInvocable: false } : s));

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

  return {
    plugins,
    commands: commands.commands,
    skills: typedSkills,
    agents: agents.agents,
    hookConfig,
    mcp,
    notes: settings.memory ? new NotesStore(home) : null,
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
  deps?: SubagentDeps;
}

/**
 * The session's tools, in a fixed order: base tools, WebFetch, Skill (when a skill is model-invocable),
 * Agent, Memory (when enabled), SessionSearch, SkillManage, then MCP tools.
 */
export function sessionTools(
  base: AnyTool[],
  ext: Extensions,
  opts: { home: string; cwd: string; holder: SubagentHolder; sessionId(): string },
): AnyTool[] {
  const tools: AnyTool[] = [...base, webFetchTool as AnyTool];
  if (ext.skills.some((s) => s.modelInvocable)) tools.push(createSkillTool(ext.skills));
  tools.push(
    createAgentTool(ext.agents, (def, prompt, ctx) => {
      const deps = opts.holder.deps;
      if (!deps) return Promise.resolve({ content: "Subagents aren't available yet in this session.", isError: true });
      return runSubagent(def, prompt, deps, ctx);
    }),
  );
  if (ext.notes) tools.push(createMemoryTool(ext.notes));
  tools.push(createSessionSearchTool({ home: opts.home, cwd: opts.cwd, currentSessionId: opts.sessionId }));
  tools.push(createSkillManageTool({ home: opts.home }));
  if (ext.mcp) tools.push(...ext.mcp.tools());
  return tools;
}

/** The context-block extras: the skill listing and the saved notes. */
export async function contextExtras(ext: Extensions, listing: (skills: Skill[]) => string): Promise<string[]> {
  return [listing(ext.skills), ext.notes ? await notesContext(ext.notes).catch(() => "") : ""];
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
