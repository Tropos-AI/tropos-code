// src/config/settings.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { projectKey } from "../paths";
import { DEFAULT_MODEL, EFFORTS, type Effort } from "./constants";

export type ThemeSetting = "auto" | "dark" | "light";

export interface PermissionRulesConfig {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface Settings {
  model: string;
  effort: Effort;
  theme: ThemeSetting;
  permissions: PermissionRulesConfig;
  additionalDirectories: string[];
  refusalFallback: boolean;
  env: Record<string, string>;
  /** Base URL overrides for built-in providers, and extra OpenAI-compatible endpoints. */
  providers: Record<string, ProviderSetting>;
  /** Background updates. Only the user's own layers may set these. */
  autoUpdates: boolean;
  autoUpdatesChannel: "latest" | "stable";
  /** Commands run on agent events. Only the user's own layers may set these, as for every key below. */
  hooks: HooksSetting;
  /** MCP servers whose tools join the session. */
  mcpServers: Record<string, McpServerSetting>;
  /** Format files after Write/Edit: true for the built-in formatters found on PATH, or named custom formatters. */
  formatter: boolean | Record<string, CommandToolSetting>;
  /** Append language-server errors to Write/Edit results: true for built-in servers found on PATH, or named servers. */
  lsp: boolean | Record<string, CommandToolSetting>;
  /** Shadow-git snapshots of the work tree before each turn, for /undo and /redo. */
  snapshots: boolean;
  /** The Memory tool and its notes in ~/.tropos/workspace (USER.md, MEMORY.md). */
  memory: boolean;
  /** Plugins under ~/.tropos/plugins that stay off. */
  disabledPlugins: string[];
  /** The background learning review and memory flush (src/learning). User layers only: it spends tokens and writes prompt text. */
  learning: LearningSettings;
}

export interface LearningSettings {
  /** Run the background review after turns. */
  review: boolean;
  /** User turns (memory) or tool calls (skills) between reviews. */
  interval: number;
  /** Fraction of the context window at which a flush review saves the session's state to the daily note. */
  flushAt: number;
  /** Periodic skill-library curation. */
  curator: boolean;
  /** Ask before Memory, DailyNote, SkillManage, AgentManage or Identity save to Tropos's own stores (the owner's saves run unasked by default). */
  askBeforeSaving: boolean;
}

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookCommand {
  type: "command";
  command: string;
  /** Seconds; default 60. */
  timeout?: number;
}

export interface HookMatcher {
  /** Tool name, `A|B` list or regex for tool events; empty or "*" matches everything. */
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksSetting = Partial<Record<HookEvent, HookMatcher[]>>;

export type McpServerSetting =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; disabled?: boolean }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; disabled?: boolean };

export interface CommandToolSetting {
  /** Argv; "$FILE" is replaced with the file's path. */
  command: string[];
  /** File extensions handled, with the dot: [".ts", ".tsx"]. */
  extensions: string[];
  disabled?: boolean;
}

export interface ProviderSetting {
  baseURL?: string;
  /** Display name for a provider that isn't built in. */
  name?: string;
  /** Which API an endpoint that isn't built in speaks: OpenAI Chat Completions (the default), OpenAI Responses, or Anthropic Messages. */
  api?: "chat" | "responses" | "anthropic";
}

export type PartialSettings = Partial<Omit<Settings, "permissions" | "learning">> & {
  permissions?: Partial<PermissionRulesConfig>;
  learning?: Partial<LearningSettings>;
};

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  effort: "high",
  theme: "auto",
  permissions: { allow: [], ask: [], deny: [] },
  additionalDirectories: [],
  refusalFallback: true,
  env: {},
  providers: {},
  autoUpdates: true,
  autoUpdatesChannel: "latest",
  hooks: {},
  mcpServers: {},
  formatter: false,
  lsp: false,
  snapshots: true,
  memory: true,
  disabledPlugins: [],
  learning: { review: true, interval: 10, flushAt: 0.7, curator: true, askBeforeSaving: false },
};

export interface SettingsPaths {
  user: string;
  userProject: string;
  project: string;
  local: string;
}

export function settingsPaths(cwd: string, home: string): SettingsPaths {
  return {
    user: join(home, "settings.json"),
    userProject: join(home, "projects", projectKey(cwd), "settings.json"),
    project: join(cwd, ".tropos", "settings.json"),
    local: join(cwd, ".tropos", "settings.local.json"),
  };
}

export class SettingsError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Invalid settings file ${path}: ${detail}`);
  }
}

const hookCommandSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  timeout: z.number().positive().max(3600).optional(),
});

export const hooksSchema = z.partialRecord(
  z.enum(HOOK_EVENTS),
  z.array(z.object({ matcher: z.string().optional(), hooks: z.array(hookCommandSchema) })),
);

export const mcpServerSchema = z.union([
  z.object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    disabled: z.boolean().optional(),
  }),
  z.object({
    type: z.enum(["http", "sse"]),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional(),
  }),
]);

const commandToolSchema = z.object({
  command: z.array(z.string()).min(1),
  extensions: z.array(z.string().regex(/^\./, "extensions start with a dot")),
  disabled: z.boolean().optional(),
});

const layerSchema = z.object({
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
  theme: z.enum(["auto", "dark", "light"]).optional(),
  permissions: z
    .object({
      allow: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  additionalDirectories: z.array(z.string()).optional(),
  refusalFallback: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  providers: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "provider ids are lowercase letters, digits and dashes"),
      z.object({ baseURL: z.string().url().optional(), name: z.string().min(1).optional(), api: z.enum(["chat", "responses", "anthropic"]).optional() }),
    )
    .optional(),
  autoUpdates: z.boolean().optional(),
  autoUpdatesChannel: z.enum(["latest", "stable"]).optional(),
  hooks: hooksSchema.optional(),
  mcpServers: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,32}$/, "MCP server names are 1-32 letters, digits, _ and -")
        // "__" separates server and tool in tool names; a leading or trailing "_" would blur that boundary too.
        .refine((name) => !name.includes("__") && !name.startsWith("_") && !name.endsWith("_"), "MCP server names can't contain __ or start or end with _"),
      mcpServerSchema,
    )
    .optional(),
  formatter: z.union([z.boolean(), z.record(z.string(), commandToolSchema)]).optional(),
  lsp: z.union([z.boolean(), z.record(z.string(), commandToolSchema)]).optional(),
  snapshots: z.boolean().optional(),
  memory: z.boolean().optional(),
  disabledPlugins: z.array(z.string()).optional(),
  learning: z
    .object({
      review: z.boolean(),
      interval: z.number().int().min(2).max(100),
      flushAt: z.number().min(0.3).max(0.95),
      curator: z.boolean(),
      askBeforeSaving: z.boolean(),
    })
    .partial()
    .optional(),
});

/** Drops undefined values so a partial layer never blanks a field it didn't set. */
function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function union(a: string[], b: string[] = []): string[] {
  return [...new Set([...a, ...b])];
}

export function mergeSettings(base: Settings, layer: PartialSettings): Settings {
  return {
    model: layer.model ?? base.model,
    effort: layer.effort ?? base.effort,
    theme: layer.theme ?? base.theme,
    permissions: {
      allow: union(base.permissions.allow, layer.permissions?.allow),
      ask: union(base.permissions.ask, layer.permissions?.ask),
      deny: union(base.permissions.deny, layer.permissions?.deny),
    },
    additionalDirectories: union(base.additionalDirectories, layer.additionalDirectories),
    refusalFallback: layer.refusalFallback ?? base.refusalFallback,
    env: { ...base.env, ...layer.env },
    providers: { ...base.providers, ...layer.providers },
    autoUpdates: layer.autoUpdates ?? base.autoUpdates,
    autoUpdatesChannel: layer.autoUpdatesChannel ?? base.autoUpdatesChannel,
    hooks: mergeHooks(base.hooks, layer.hooks),
    mcpServers: { ...base.mcpServers, ...layer.mcpServers },
    formatter: layer.formatter ?? base.formatter,
    lsp: layer.lsp ?? base.lsp,
    snapshots: layer.snapshots ?? base.snapshots,
    memory: layer.memory ?? base.memory,
    disabledPlugins: union(base.disabledPlugins, layer.disabledPlugins),
    learning: { ...base.learning, ...definedOnly(layer.learning) },
  };
}

/** Hooks from every layer run: matchers are appended per event, never replaced. */
export function mergeHooks(base: HooksSetting, layer: HooksSetting = {}): HooksSetting {
  const merged: HooksSetting = { ...base };
  for (const event of HOOK_EVENTS) {
    const extra = layer[event];
    if (extra?.length) merged[event] = [...(base[event] ?? []), ...extra];
  }
  return merged;
}

async function readJson(path: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SettingsError(path, (err as Error).message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SettingsError(path, (err as Error).message);
  }
}

export async function readSettingsFile(path: string): Promise<PartialSettings | null> {
  const raw = await readJson(path);
  if (raw === null) return null;
  const parsed = layerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsError(path, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

/** Anthropic model ids have no slash; "anthropic/<id>" names the same model. */
export function isAnthropicModelId(model: string): boolean {
  return !model.includes("/") || (model.startsWith("anthropic/") && !model.slice("anthropic/".length).includes("/"));
}

const REPO_RESTRICTION_HINT =
  "repo settings may only set an Anthropic model, effort, theme, refusalFallback and ask/deny rules; put the rest in ~/.tropos";

/**
 * Repo-shipped files arrive with the code, so they cannot grant allow rules, env or extra
 * directories. Keeps only the keys they may set and reports anything dropped.
 */
function restrictRepoLayer(path: string, layer: PartialSettings): { layer: PartialSettings; warning?: string } {
  const ignored: string[] = [];
  if (layer.permissions?.allow?.length) ignored.push("permissions.allow");
  if (layer.env && Object.keys(layer.env).length > 0) ignored.push("env");
  if (layer.additionalDirectories?.length) ignored.push("additionalDirectories");
  // A repo-chosen base URL would send the user's API keys wherever the repo likes.
  if (layer.providers && Object.keys(layer.providers).length > 0) ignored.push("providers");
  // A repo that turns updates off or picks the channel could keep its users on an old version.
  if (layer.autoUpdates !== undefined) ignored.push("autoUpdates");
  if (layer.autoUpdatesChannel !== undefined) ignored.push("autoUpdatesChannel");
  // Hooks, MCP servers, formatters and language servers run programs; plugins choose which run.
  // Learning spends the user's tokens in the background and writes prompt text under ~/.tropos.
  for (const key of ["hooks", "mcpServers", "formatter", "lsp", "snapshots", "memory", "disabledPlugins", "learning"] as const) {
    if (layer[key] !== undefined) ignored.push(key);
  }
  // A model id picks the provider too ("deepseek/…", "ollama/…"): a repo may choose among Anthropic
  // models, but not send the session, and the user's key, to another provider or a local server.
  const model = layer.model !== undefined && !isAnthropicModelId(layer.model) ? undefined : layer.model;
  if (layer.model !== undefined && model === undefined) ignored.push("model (another provider)");
  const restricted: PartialSettings = {
    model,
    effort: layer.effort,
    theme: layer.theme,
    refusalFallback: layer.refusalFallback,
    permissions: { ask: layer.permissions?.ask, deny: layer.permissions?.deny },
  };
  if (ignored.length === 0) return { layer: restricted };
  return { layer: restricted, warning: `${path}: ignored ${ignored.join(", ")} (${REPO_RESTRICTION_HINT})` };
}

export interface LoadedSettings {
  settings: Settings;
  /** Notices for the user, such as repo-shipped keys that were ignored. */
  warnings: string[];
}

/** Merge order: user, userProject, project, local, then CLI overrides (trusted). */
export async function loadSettings(paths: SettingsPaths, overrides: PartialSettings = {}): Promise<LoadedSettings> {
  let settings = DEFAULT_SETTINGS;
  const warnings: string[] = [];
  const layers: Array<[path: string, trusted: boolean]> = [
    [paths.user, true],
    [paths.userProject, true],
    [paths.project, false],
    [paths.local, false],
  ];
  for (const [path, trusted] of layers) {
    const parsed = await readSettingsFile(path);
    if (!parsed) continue;
    const { layer, warning } = trusted ? { layer: parsed, warning: undefined } : restrictRepoLayer(path, parsed);
    if (warning) warnings.push(warning);
    settings = mergeSettings(settings, layer);
  }
  return { settings: mergeSettings(settings, overrides), warnings };
}

/** Adds an allow rule to the project-local settings file, keeping every other key as-is. */
export async function addLocalAllowRule(localPath: string, rule: string): Promise<void> {
  const raw = ((await readJson(localPath)) ?? {}) as Record<string, unknown>;
  const permissions = (raw.permissions ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  if (!allow.includes(rule)) allow.push(rule);
  const next = { ...raw, permissions: { ...permissions, allow } };
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, `${JSON.stringify(next, null, 2)}\n`);
}

/** The schema of one settings file (user, project or local): the config store validates writes with it. */
export { layerSchema as settingsLayerSchema };
