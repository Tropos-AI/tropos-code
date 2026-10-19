// src/tools/setup/plugin-install.ts — TroposSetup's plugin actions: install from a git repository (a marketplace's
// plugin included) or a local folder, find, remove. Installing runs nothing from the plugin: the files are fetched into
// a hidden staging folder (the loader skips dot folders), the manifest, hooks and servers are validated there, and a
// plugin that would run programs lands switched off, so turning it on is a second approval that shows what it runs.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { readUserSettingsRaw, setAt, unsetAt, updateUserSettings } from "../../config/store";
import { MANIFESTS, readPlugin, type LoadedPlugin } from "../../extensions/plugins";
import { isInside } from "../../paths";
import { fetchTree, folderIn } from "./fetch-tree";
import { parseSource, subdirProblem } from "./sources";

export const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;

export interface PluginOpsDeps {
  /** The Tropos home; plugins live in <home>/plugins. */
  home: string;
  cloneEnv?: NodeJS.ProcessEnv;
  maxBytes?: number;
}

export interface PluginRequest {
  /** A git URL (https, or file:// on this computer), a GitHub folder link, or a local folder. */
  source: string;
  /** The plugin to take from a marketplace repository. */
  name?: string;
  /** The folder inside the repository that holds the plugin. */
  subdir?: string;
}

/** One program a plugin runs, as its approval shows it: what runs it, and the text. */
export interface PluginRun {
  what: string;
  text: string;
}

export interface InstalledPlugin {
  name: string;
  root: string;
  enabled: boolean;
  runs: PluginRun[];
}

const pluginsDir = (home: string): string => join(home, "plugins");

/** One shell word, quoted when it needs to be. */
const word = (w: string): string => (/^[\w@%+=:,./${}-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/** Every program the plugin runs when on, exactly as the loader will run it (root filled in). */
export function pluginRuns(plugin: LoadedPlugin): PluginRun[] {
  const runs: PluginRun[] = [];
  for (const [event, matchers] of Object.entries(plugin.hooks)) {
    for (const m of matchers ?? []) for (const h of m.hooks) runs.push({ what: `hook ${event}${m.matcher ? ` (${m.matcher})` : ""}`, text: h.command });
  }
  for (const [name, s] of Object.entries(plugin.mcpServers)) {
    const what = `MCP server ${name}`;
    if ("url" in s) {
      runs.push({ what, text: s.url });
      for (const [k, v] of Object.entries(s.headers ?? {})) runs.push({ what: `${what} header ${k}`, text: v });
      continue;
    }
    runs.push({ what, text: [s.command, ...(s.args ?? [])].map(word).join(" ") });
    for (const [k, v] of Object.entries(s.env ?? {})) runs.push({ what: `${what} env ${k}`, text: v });
    if (s.cwd) runs.push({ what: `${what} cwd`, text: s.cwd });
  }
  return runs;
}

/** The installed plugin with this name, read from disk as the loader would read it switched on; undefined when none. */
export function findPlugin(home: string, name: string): LoadedPlugin | undefined {
  let entries: string[];
  try {
    entries = readdirSync(pluginsDir(home)).sort();
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const root = join(pluginsDir(home), entry);
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    const read = readPlugin(root, entry, () => true);
    if (read.ok && read.plugin.name === name) return read.plugin;
  }
  return undefined;
}

async function disabledPlugins(home: string): Promise<string[]> {
  const raw = await readUserSettingsRaw(home);
  return Array.isArray(raw.disabledPlugins) ? raw.disabledPlugins.filter((x): x is string => typeof x === "string") : [];
}

const marketplaceSchema = z.object({
  plugins: z.array(z.object({ name: z.string(), source: z.union([z.string(), z.object({ source: z.string(), repo: z.string().optional(), url: z.string().optional() })]) })),
  metadata: z.object({ pluginRoot: z.string().optional() }).optional(),
});

/**
 * The plugin folder in a fetched tree: the folder itself when it has a manifest, else the entry `name` of a Claude Code
 * marketplace (.claude-plugin/marketplace.json) in it. `entry` is the name the plugin goes by when it has no manifest.
 */
function pluginFolder(dir: string, name: string | undefined, fallback: string): { dir: string; entry: string; listed: boolean } {
  const plain = { dir, entry: name ?? fallback, listed: false };
  if (MANIFESTS.some((m) => existsSync(join(dir, m)))) return plain;
  const file = join(dir, ".claude-plugin", "marketplace.json");
  if (!existsSync(file)) return plain;
  let market: z.infer<typeof marketplaceSchema>;
  try {
    market = marketplaceSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error("Its plugin marketplace file (.claude-plugin/marketplace.json) isn't valid.");
  }
  const names = market.plugins.map((p) => p.name).join(", ");
  if (!name) throw new Error(`That repository is a plugin marketplace with: ${names}. Say which one to install.`);
  const listed = market.plugins.find((p) => p.name === name);
  if (!listed) throw new Error(`The marketplace has no plugin named ${name}; it has: ${names}.`);
  if (typeof listed.source !== "string") {
    const url = listed.source.repo ? `https://github.com/${listed.source.repo}.git` : listed.source.url;
    throw new Error(`${name} lives in another repository${url ? `: install it from ${url}` : ""}.`);
  }
  const root = market.metadata?.pluginRoot;
  const rel = listed.source.startsWith("./") || !root ? listed.source : join(root, listed.source);
  const problem = subdirProblem(rel);
  if (problem) throw new Error(`The marketplace's folder for ${name} isn't usable. ${problem}`);
  return { dir: join(dir, rel), entry: name, listed: true };
}

/** Installs a plugin into <home>/plugins/<name>. Throws a readable Error; a failure leaves nothing behind. */
export async function installPlugin(deps: PluginOpsDeps, req: PluginRequest): Promise<InstalledPlugin> {
  const source = parseSource(req.source, req.subdir);
  if ("problem" in source) throw new Error(source.problem);
  if (source.kind === "file") throw new Error("A plugin is a folder: give its git repository (or a folder on this computer), not one file.");
  const base = pluginsDir(deps.home);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const staging = join(base, `.install-${randomBytes(6).toString("hex")}`);
  try {
    const tree = join(staging, "tree");
    await fetchTree(source, tree, { maxBytes: deps.maxBytes ?? MAX_PLUGIN_BYTES, ...(deps.cloneEnv ? { cloneEnv: deps.cloneEnv } : {}) });
    const subdir = source.kind === "local" ? req.subdir : source.subdir;
    // A manifest without a name: the plugin goes by its folder's (or repository's) name, as the loader would call it.
    const fallback = basename((subdir ?? (source.kind === "local" ? source.path : new URL(source.url).pathname)).replace(/\/+$/, "")).replace(/\.git$/, "");
    const found = pluginFolder(await folderIn(tree, subdir), req.name, fallback);
    if (!existsSync(found.dir)) throw new Error(`The marketplace names a folder for ${found.entry} that isn't there.`);
    const read = readPlugin(found.dir, found.entry, () => true);
    if (!read.ok) throw new Error(`That plugin can't be installed: ${read.reason}.`);
    if (!read.manifest && !found.listed) throw new Error("That isn't a plugin: it has no plugin.json (.claude-plugin/plugin.json).");
    if (read.warnings.length) throw new Error(`That plugin can't be installed: ${read.warnings.join("; ")}.`);
    const name = read.plugin.name;
    const dest = join(base, name);
    if (findPlugin(deps.home, name) || existsSync(dest)) throw new Error(`A plugin named ${name} is already installed. Remove it first to install it again.`);
    // Off before it is in place: no session may load a plugin's programs that nobody has seen yet.
    const off = await disabledPlugins(deps.home);
    const runsPrograms = pluginRuns(read.plugin).length > 0;
    if (runsPrograms && !off.includes(name)) await updateUserSettings(deps.home, (draft) => setAt(draft, ["disabledPlugins"], [...off, name]));
    await rename(found.dir, dest);
    const placed = readPlugin(dest, name, () => true);
    return { name, root: dest, enabled: !runsPrograms && !off.includes(name), runs: placed.ok ? pluginRuns(placed.plugin) : [] };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Deletes an installed plugin (a linked one loses only its link) and its off switch. Returns the folder it removed. */
export async function removePlugin(home: string, name: string): Promise<string> {
  const plugin = findPlugin(home, name);
  if (!plugin || !isInside(plugin.root, pluginsDir(home))) throw new Error(`There is no plugin named ${name.slice(0, 60)}.`);
  // The folder goes first: were the switch cleared first and the delete to fail, the plugin would come back on.
  if (lstatSync(plugin.root).isSymbolicLink()) await unlink(plugin.root);
  else await rm(plugin.root, { recursive: true, force: true });
  const off = await disabledPlugins(home).catch(() => [] as string[]);
  if (off.includes(name)) {
    const rest = off.filter((n) => n !== name);
    await updateUserSettings(home, (draft) => (rest.length ? setAt(draft, ["disabledPlugins"], rest) : unsetAt(draft, ["disabledPlugins"])));
  }
  return plugin.root;
}
