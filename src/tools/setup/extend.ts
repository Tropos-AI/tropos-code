// src/tools/setup/extend.ts — TroposSetup's actions that extend Tropos itself: MCP servers (edit, remove, list, test),
// plugins (install, enable, disable, remove, list), skills from a URL, and downloads into the project. The tool's own
// checks (owner only, the approval preview, text the approval can't show) have run before any of these.
import { readUserSettingsRaw, setAt, updateUserSettings, type ConfigFileName } from "../../config/store";
import { mcpServerSchema } from "../../config/settings";
import { loadPlugins } from "../../extensions/plugins";
import type { Ledger } from "../../learning/ledger";
import type { Admin } from "../../web/admin";
import type { McpServerView } from "../../web/admin/api";
import type { ToolContext } from "../types";
import { download } from "./download";
import { editedServer, mcpServerProblem, SetupRefused, unshowable, unshowableText, type SetupAction, type SetupInput } from "./matrix";
import { findPlugin, installPlugin, pluginRuns, removePlugin } from "./plugin-install";
import { installSkill } from "./skill-install";

/** What the tool lends these actions: the admin, the reload signal, the ledger wrapper, the vault. */
export interface ExtendKit {
  home: string;
  admin: Admin;
  ledger: Ledger;
  reload: () => Promise<unknown>;
  link: (route?: string) => string;
  /** Runs `work` and records what it changed in these config values (see setup-tool.ts). */
  changing: (touched: { file: ConfigFileName; paths: string[] }[], summary: string, work: () => Promise<string>, noUndo?: string) => Promise<string>;
  /** MCP env entries with their secret:<n> refs taken from the vault; refuses when one has expired. */
  envFromVault: (env: Record<string, string>) => Record<string, string>;
  fetch?: typeof fetch;
  cloneEnv?: NodeJS.ProcessEnv;
}

export const EXTEND_ACTIONS = ["mcp.edit", "mcp.remove", "mcp.list", "mcp.test", "plugin.install", "plugin.enable", "plugin.disable", "plugin.remove", "plugin.list", "skill.install", "download"] as const satisfies readonly SetupAction[];
export type ExtendAction = (typeof EXTEND_ACTIONS)[number];

const refuse = (text: string): never => {
  throw new SetupRefused(text);
};
const need = <T>(value: T | undefined, what: string): T => (value === undefined || value === "" ? refuse(what) : value);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

async function configuredServer(home: string, name: string): Promise<Record<string, unknown>> {
  const server = (await readUserSettingsRaw(home).catch(() => ({}) as Record<string, unknown>)).mcpServers;
  const current = isObject(server) ? server[name] : undefined;
  return isObject(current) ? current : refuse(`There is no MCP server named ${name}.`);
}

function mcpListText(servers: McpServerView[]): string {
  if (!servers.length) return "No MCP servers are set up.";
  const lines = servers.map((s) => `- ${s.name} (${s.type}): ${s.state}${s.tools !== undefined ? `, ${plural(s.tools, "tool")}` : ""}${s.error ? ` (${oneLine(s.error, 160)})` : ""} — ${s.target}`);
  return ["MCP servers:", ...lines].join("\n");
}

export async function performExtend(action: ExtendAction, input: SetupInput, ctx: ToolContext, kit: ExtendKit): Promise<string> {
  const { home, admin } = kit;
  const settings = (...paths: string[]) => [{ file: "settings" as const, paths }];
  switch (action) {
    case "mcp.edit": {
      const name = need(input.name, "Say which MCP server.");
      const change = need(input.server, "Say what to change: the command, its arguments, the URL, or a key.");
      const problem = mcpServerProblem(change, kit.link("extensions/mcp"));
      if (problem) refuse(problem);
      const current = await configuredServer(home, name);
      const next = editedServer(current, change, kit.envFromVault(change.env ?? {}));
      const parsed = mcpServerSchema.safeParse(next);
      if (!parsed.success) refuse(`That change leaves ${name} without a ${typeof next.url === "string" || change.url !== undefined ? "valid URL" : "command"}; say the whole command or URL.`);
      return kit.changing(settings(`mcpServers.${name}`), `edit MCP server ${name}`, async () => {
        await updateUserSettings(home, (draft) => setAt(draft, ["mcpServers", name], next));
        await kit.reload();
        return `Changed the MCP server ${name}. New sessions use it.`;
      });
    }
    case "mcp.remove": {
      const name = need(input.name, "Say which MCP server to remove.");
      return kit.changing(settings(`mcpServers.${name}`), `remove MCP server ${name}`, async () => {
        await admin.handle("mcp.remove", { name });
        return `Removed the MCP server ${name}. New sessions don't start it.`;
      });
    }
    case "mcp.list":
      return mcpListText((await admin.handle("mcp.list", undefined)) as McpServerView[]);
    case "mcp.test": {
      const name = need(input.name, "Say which MCP server to test.");
      const server = await configuredServer(home, name);
      const out = (await admin.handle("mcp.test", { server })) as { ok: boolean; tools: string[]; error?: string };
      if (!out.ok) return refuse(`The MCP server ${name} didn't start: ${out.error ?? "no reason given"}`);
      const shown = out.tools.slice(0, 30).join(", ");
      return `The MCP server ${name} started and offers ${plural(out.tools.length, "tool")}${out.tools.length ? `: ${shown}${out.tools.length > 30 ? ", …" : ""}` : ""}.`;
    }
    case "plugin.install": {
      const source = need(input.source, "Say where the plugin is: its git URL, or a folder on this computer.");
      return kit.changing(settings("disabledPlugins"), `install plugin from ${source}`, async () => {
        const p = await installPlugin({ home, ...(kit.cloneEnv ? { cloneEnv: kit.cloneEnv } : {}) }, { source, ...(input.name ? { name: input.name } : {}), ...(input.subdir ? { subdir: input.subdir } : {}) });
        await kit.reload();
        const head = `Installed the plugin ${p.name} in ${p.root}.`;
        if (p.enabled) return `${head} It is on: new sessions load its commands, skills and agents.`;
        if (!p.runs.length) return `${head} It is off (it was switched off before); ask me to turn it on.`;
        const runs = p.runs.map((r) => `- ${r.what}: ${r.text}`);
        return [`${head} It is off, because it runs programs on this computer:`, ...runs, "Ask me to turn it on when you're happy with that; you'll approve exactly this list."].join("\n");
      }, "Remove the plugin instead.");
    }
    case "plugin.enable":
    case "plugin.disable": {
      const name = need(input.name, "Say which plugin.");
      const enabled = action === "plugin.enable";
      const plugin = findPlugin(home, name) ?? refuse(`There is no plugin named ${name}.`);
      // What runs once it is on is exactly what the approval listed: anything it couldn't show whole is refused.
      const hidden = enabled ? pluginRuns(plugin).find((r) => unshowableText(r.what) || unshowable(r.text)) : undefined;
      if (hidden) refuse(`The plugin ${name} runs something I can't show you whole for approval (${unshowableText(hidden.what) ? "a hook" : hidden.what}). Turn it on in Settings → Extensions instead: ${kit.link("extensions/plugins")}`);
      return kit.changing(settings("disabledPlugins"), `${enabled ? "enable" : "disable"} plugin ${name}`, async () => {
        await admin.handle("plugins.setEnabled", { name, enabled });
        return `The plugin ${name} is ${enabled ? "on" : "off"} for new sessions.`;
      });
    }
    case "plugin.remove": {
      const name = need(input.name, "Say which plugin to remove.");
      return kit.changing(settings("disabledPlugins"), `remove plugin ${name}`, async () => {
        const root = await removePlugin(home, name);
        await kit.reload();
        return `Removed the plugin ${name} (${root}).`;
      }, "This can't be undone.");
    }
    case "plugin.list": {
      const raw = await readUserSettingsRaw(home).catch(() => ({}) as Record<string, unknown>);
      const off = Array.isArray(raw.disabledPlugins) ? raw.disabledPlugins.filter((x): x is string => typeof x === "string") : [];
      const { plugins } = await loadPlugins(home, off);
      if (!plugins.length) return "No plugins are installed.";
      const lines = plugins.map((p) => `- ${p.name}: ${p.enabled ? "on" : "off"}${p.version ? ` (v${oneLine(p.version, 20)})` : ""}${p.description ? ` — ${oneLine(p.description, 120)}` : ""}`);
      return ["Plugins:", ...lines].join("\n");
    }
    case "skill.install": {
      const source = need(input.source, "Say where the skill is: the URL of its SKILL.md, or its git repository and folder.");
      const out = await installSkill(
        { home, ledger: kit.ledger, actor: ctx.actor ?? "agent", ...(kit.fetch ? { fetch: kit.fetch } : {}), ...(kit.cloneEnv ? { cloneEnv: kit.cloneEnv } : {}) },
        { source, ...(input.name ? { name: input.name } : {}), ...(input.subdir ? { subdir: input.subdir } : {}) },
      );
      await kit.reload();
      return `Installed the skill ${out.name} in ${out.dir} (${out.files.join(", ")}). New sessions can use it.`;
    }
    case "download": {
      const url = need(input.url, "Say which URL to download.");
      const out = await download(
        { url, ...(input.path ? { path: input.path } : {}), ...(input.overwrite ? { overwrite: true } : {}) },
        { cwd: ctx.cwd(), allowedDirs: ctx.allowedDirs },
        { ...(kit.fetch ? { fetch: kit.fetch } : {}) },
      );
      return `Downloaded ${url} to ${out.path}: ${out.size.toLocaleString("en-US")} bytes, sha256 ${out.sha256}.`;
    }
  }
}
