// src/extensions/plugins.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HOOK_EVENTS, hooksSchema, mcpServerSchema, type HooksSetting, type McpServerSetting } from "../config/settings";
import { errorText } from "../error-text";
import type { PluginRoot } from "./sources";

export interface LoadedPlugin {
  name: string;
  root: string;
  version?: string;
  description?: string;
  hooks: HooksSetting;
  /** Already named `<plugin>-<server>`. */
  mcpServers: Record<string, McpServerSetting>;
  enabled: boolean;
}

/** Manifest locations, first found wins: Tropos's own, Claude Code's, then a bare plugin.json. */
const MANIFESTS = [join(".tropos-plugin", "plugin.json"), join(".claude-plugin", "plugin.json"), "plugin.json"];

const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Other keys (author, homepage…) are allowed and ignored, so Claude Code manifests load. */
const manifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME, "plugin names are kebab-case").optional(),
  version: z.string().optional(),
  description: z.string().optional(),
});

const mcpFileSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() });

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Parsed JSON, null when the file is absent; throws with a readable message otherwise. */
async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  return JSON.parse(text) as unknown;
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

/**
 * Plugins written for Claude Code refer to their own folder as ${CLAUDE_PLUGIN_ROOT}; the hook
 * runner and MCP manager don't know which plugin a command came from, so it is filled in here.
 */
function fillRoot(text: string, root: string): string {
  return text.replace(/\$\{(?:TROPOS|CLAUDE)_PLUGIN_ROOT\}/g, () => root);
}

async function loadHooks(name: string, root: string, warnings: string[]): Promise<HooksSetting> {
  const path = join(root, "hooks", "hooks.json");
  let raw: unknown;
  try {
    raw = await readJson(path);
  } catch (err) {
    warnings.push(`Plugin ${name}: cannot read hooks/hooks.json: ${errorText(err)}`);
    return {};
  }
  if (raw === null) return {};
  // Claude Code's file wraps the events in { "hooks": … }; accept that and the bare settings shape.
  const wrapped = raw && typeof raw === "object" && !Array.isArray(raw) && "hooks" in raw ? (raw as { hooks: unknown }).hooks : raw;
  if (!wrapped || typeof wrapped !== "object" || Array.isArray(wrapped)) {
    warnings.push(`Plugin ${name}: hooks/hooks.json must be an object of hook events`);
    return {};
  }
  const known = new Set<string>(HOOK_EVENTS);
  const events = Object.keys(wrapped).filter((k) => !known.has(k));
  if (events.length > 0) warnings.push(`Plugin ${name}: ignored unsupported hook events: ${events.join(", ")}`);
  const kept = Object.fromEntries(Object.entries(wrapped).filter(([k]) => known.has(k)));
  const parsed = hooksSchema.safeParse(kept);
  if (!parsed.success) {
    warnings.push(`Plugin ${name}: hooks/hooks.json ignored: ${issues(parsed.error)}`);
    return {};
  }
  const hooks: HooksSetting = {};
  for (const [event, matchers] of Object.entries(parsed.data) as [keyof HooksSetting, NonNullable<HooksSetting[keyof HooksSetting]>][]) {
    hooks[event] = matchers.map((m) => ({ ...m, hooks: m.hooks.map((h) => ({ ...h, command: fillRoot(h.command, root) })) }));
  }
  return hooks;
}

function fillServerRoot(server: McpServerSetting, root: string): McpServerSetting {
  if ("url" in server) return server;
  return {
    ...server,
    command: fillRoot(server.command, root),
    args: server.args?.map((a) => fillRoot(a, root)),
    env: server.env && Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, fillRoot(v, root)])),
    cwd: server.cwd && fillRoot(server.cwd, root),
  };
}

async function loadMcpServers(name: string, root: string, warnings: string[]): Promise<Record<string, McpServerSetting>> {
  let raw: unknown;
  try {
    raw = await readJson(join(root, ".mcp.json"));
  } catch (err) {
    warnings.push(`Plugin ${name}: cannot read .mcp.json: ${errorText(err)}`);
    return {};
  }
  if (raw === null) return {};
  const file = mcpFileSchema.safeParse(raw);
  if (!file.success) {
    warnings.push(`Plugin ${name}: .mcp.json ignored: ${issues(file.error)}`);
    return {};
  }
  const servers: Record<string, McpServerSetting> = {};
  // One bad server is skipped on its own; the plugin's other servers still load.
  for (const [server, value] of Object.entries(file.data.mcpServers ?? {})) {
    const full = `${name}-${server}`;
    // Same limits as settings: "__" or an over-long name would blur which server a tool belongs to.
    if (!SERVER_NAME.test(server) || full.includes("__") || full.endsWith("_") || full.length > 32) {
      warnings.push(`Plugin ${name}: MCP server "${server}" skipped: names are letters, digits, _ and -, without "__" or a trailing "_", and "${name}-<server>" fits in 32 characters`);
      continue;
    }
    const parsed = mcpServerSchema.safeParse(value);
    if (!parsed.success) {
      warnings.push(`Plugin ${name}: MCP server "${server}" skipped: ${issues(parsed.error)}`);
      continue;
    }
    servers[full] = fillServerRoot(parsed.data, root);
  }
  return servers;
}

/** Reads the first manifest found; null when the plugin has none. */
async function readManifest(root: string): Promise<{ path: string; data: unknown } | null> {
  for (const rel of MANIFESTS) {
    const data = await readJson(join(root, rel));
    if (data !== null) return { path: rel, data };
  }
  return null;
}

/**
 * Loads the plugins under `<home>/plugins` (home is the Tropos home, ~/.tropos). Repo plugins
 * never load: a plugin runs programs. Every plugin is enabled unless its name is in `disabled`;
 * a disabled plugin is still listed, without reading its hooks or servers. A broken plugin or
 * file becomes a warning, never an exception.
 */
export async function loadPlugins(home: string, disabled: string[]): Promise<{ plugins: LoadedPlugin[]; warnings: string[] }> {
  const warnings: string[] = [];
  const plugins: LoadedPlugin[] = [];
  const base = join(home, "plugins");
  let entries: string[];
  try {
    entries = (await readdir(base)).sort();
  } catch (err) {
    if (!isMissing(err)) warnings.push(`Cannot read ${base}: ${errorText(err)}`);
    return { plugins, warnings };
  }
  const off = new Set(disabled);
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const root = join(base, entry);
    try {
      if (!(await stat(root)).isDirectory()) continue;
    } catch {
      continue; // a dangling symlink
    }
    let manifest: z.infer<typeof manifestSchema> = {};
    try {
      const found = await readManifest(root);
      if (found) {
        const parsed = manifestSchema.safeParse(found.data);
        if (!parsed.success) {
          warnings.push(`Skipped plugin ${entry}: ${found.path}: ${issues(parsed.error)}`);
          continue;
        }
        manifest = parsed.data;
      }
    } catch (err) {
      warnings.push(`Skipped plugin ${entry}: bad manifest: ${errorText(err)}`);
      continue;
    }
    const name = manifest.name ?? entry;
    if (!PLUGIN_NAME.test(name)) {
      warnings.push(`Skipped plugin ${entry}: plugin names are kebab-case (set "name" in its plugin.json)`);
      continue;
    }
    if (plugins.some((p) => p.name === name)) {
      warnings.push(`Skipped plugin ${entry}: another plugin is already named ${name}`);
      continue;
    }
    const enabled = !off.has(name);
    plugins.push({
      name,
      root,
      version: manifest.version,
      description: manifest.description,
      hooks: enabled ? await loadHooks(name, root, warnings) : {},
      mcpServers: enabled ? await loadMcpServers(name, root, warnings) : {},
      enabled,
    });
  }
  return { plugins, warnings };
}

/** The enabled plugins, for extensionDirs. */
export function pluginRoots(plugins: LoadedPlugin[]): PluginRoot[] {
  return plugins.filter((p) => p.enabled).map((p) => ({ name: p.name, root: p.root }));
}
