// src/tools/setup/describe.ts — the permission preview of a setup change: exactly what changes, as "before → after".
// It never shows a secret: keys are named by their secret:<n> ref, anything else in an MCP env is hidden.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { gatewayConfigPath } from "../../gateway/config";
import { resolveLayoutPath } from "../../home/layout";
import type { PermissionPreview } from "../types";
import { downloadName, downloadUrlProblem, MAX_DOWNLOAD_BYTES } from "./download";
import { allowedEnvEntry, editedServer, looksSecret, SECRET_REF, unshowable, unshowableText, type SetupInput } from "./matrix";
import { findPlugin, pluginRuns } from "./plugin-install";
import { parseSource } from "./sources";

/** The config files as they are; `home` (the Tropos home) lets a plugin's or skill's preview read what is installed. */
export type SetupState = { settings: Record<string, unknown>; gateway: Record<string, unknown>; home?: string };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(path: string): Json {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

/** settings.json and gateway.json as they are on disk (sync: a preview is built synchronously); unreadable is `{}`. */
export function readSetupState(home: string): SetupState {
  return { settings: readJson(join(home, "settings.json")), gateway: readJson(gatewayConfigPath(home)) };
}

const RANK: Record<string, number> = { ask: 0, balanced: 1, autonomous: 2 };

const obj = (v: unknown): Json => (isObject(v) ? v : {});
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);
const projectsOf = (s: SetupState): Json[] => (Array.isArray(s.gateway.projects) ? s.gateway.projects.filter(isObject) : []);
const arrow = (label: string, before: unknown, after: unknown): string => `${label}: ${String(before)} → ${String(after)}`;

/** A key the request carries: its ref, or that one was pasted (a raw value is never repeated). */
const keyNote = (secret: string | undefined): string => (secret === undefined ? "(no key given)" : SECRET_REF.test(secret) ? `(${secret}, not shown)` : "(pasted key, not shown)");

/** JSON-quoted with everything outside printable ASCII escaped, so nothing invisible reaches the approval. */
const quoted = (text: string): string => JSON.stringify(text).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * An env entry's value as the approval shows it: a vault ref by name, a raw key never, anything else in full and
 * JSON-quoted. Never cut. Entries the tool won't write (anything but a key from the vault) are marked refused.
 */
function envValue(name: string, value: string): string {
  if (allowedEnvEntry(name, value)) return `(${value})`;
  const why = unshowable(value);
  if (why) return `(refused: it ${why})`;
  if (looksSecret(name, value)) return "(a pasted key: refused, it must be a secret:<n> ref)";
  return `${quoted(value)} (refused: set it in Settings → Extensions)`;
}

/** Something that will run, as the approval shows it: whole, or the reason it is refused. */
const shown = (text: string, render: (t: string) => string): string => {
  const why = unshowable(text);
  return why ? `(refused: it ${why})` : render(text);
};

/** A name, path or id (the request's, or one read from the config): as it is, or the reason it is refused. */
const t = (value: unknown, fallback = "?"): string => {
  const text = typeof value === "string" && value ? value : fallback;
  const why = unshowableText(text);
  return why ? `(refused: it ${why})` : text;
};

/** One shell word, quoted when it needs to be, so the approval shows the command that will run. */
const word = (w: string): string => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function proactiveOn(s: SetupState): boolean {
  const enabled = obj(s.gateway.proactive).enabled;
  if (typeof enabled === "boolean") return enabled;
  // Unset follows Telegram: on once a bot is connected.
  return typeof obj(s.gateway.telegram).botToken === "string";
}

/** A configured MCP server as the approval shows what it runs: its command line, or its URL. */
function serverLine(s: Json): string {
  if (typeof s.url === "string") return shown(s.url, (u) => u);
  const words = [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter((w): w is string => typeof w === "string");
  return words.length ? words.map((w) => shown(w, word)).join(" ") : "(no command)";
}

/** What is fetched for an install, exactly: a clone (with its branch and folder), a file, or a local folder. */
function fetchLine(source: string | undefined, subdir: string | undefined): string {
  if (source === undefined) return "source: (none given)";
  const why = unshowable(source) ?? (subdir === undefined ? undefined : unshowable(subdir));
  if (why) return `source: (refused: it ${why})`;
  const from = parseSource(source, subdir);
  if ("problem" in from) return `source: (refused: ${from.problem})`;
  if (from.kind === "file") return `fetch: ${from.url}`;
  if (from.kind === "local") return `copy the folder: ${t(from.path)}${subdir ? `, folder ${subdir}` : ""} (links inside are refused)`;
  return `clone (shallow, no git hooks run): ${from.url}${from.ref ? `, branch ${from.ref}` : ""}${from.subdir ? `, folder ${from.subdir}` : ""}`;
}

const disabledPlugins = (s: SetupState): string[] => (Array.isArray(s.settings.disabledPlugins) ? s.settings.disabledPlugins.filter((x): x is string => typeof x === "string") : []);
const mb = (n: number): string => `${Math.round(n / 1024 / 1024)} MB`;

export function describeSetupChange(input: SetupInput, state: SetupState): PermissionPreview {
  const header = `TroposSetup: ${input.action}`;
  const lines: string[] = [];
  const connected = typeof obj(state.gateway.telegram).botToken === "string";
  switch (input.action) {
    case "telegram.connect":
      lines.push(`Telegram: ${connected ? "replace the connected bot" : "not connected → connected"} with the bot token ${keyNote(input.secret)}`);
      break;
    case "telegram.disconnect":
      lines.push(`Telegram: ${connected ? "connected" : "not connected"} → not connected (the bot token is removed)`);
      break;
    case "project.add":
      lines.push(`projects: add ${t(input.path, "(no folder given)")}${input.name ? ` as "${t(input.name)}"` : ""}`);
      break;
    case "project.create":
      lines.push(`projects: create a folder "${t(input.name, "")}" in ${t(state.gateway.newProjectsDir, "~/Projects")}, run git init and add it as a project`);
      break;
    case "project.rename": {
      const p = projectsOf(state).find((x) => x.id === input.project);
      lines.push(arrow(`project ${t(input.project)} name`, p ? t(p.name) : "(unknown project)", t(input.name)));
      break;
    }
    case "project.remove": {
      const p = projectsOf(state).find((x) => x.id === input.project);
      lines.push(`projects: remove ${t(input.project)}${p ? ` (${t(p.path)})` : ""}; the folder itself stays on disk`);
      break;
    }
    case "project.default":
      lines.push(arrow("default project", t(state.gateway.defaultProject, "default"), t(input.project)));
      break;
    case "model.set":
      if (input.model !== undefined) lines.push(arrow("model", t(state.settings.model, "(default)"), t(input.model)));
      if (input.effort !== undefined) lines.push(arrow("effort", str(state.settings.effort, "(default)"), input.effort));
      if (!lines.length) lines.push("(nothing to change)");
      lines.push("New sessions use it; open conversations keep their model until /new.");
      break;
    case "provider.connect":
      lines.push(`provider ${t(input.provider)}: connect with the API key ${keyNote(input.secret)}`);
      break;
    case "mcp.add": {
      const server = input.server ?? {};
      const exists = isObject(obj(state.settings.mcpServers)[input.name ?? ""]);
      lines.push(`MCP server ${t(input.name)}: ${exists ? "already exists (it is not replaced)" : "add"}`);
      lines.push(`type: ${server.type ?? (server.url ? "http" : "stdio")}`);
      if (server.command) lines.push(`command: ${[server.command, ...(server.args ?? [])].map((w) => shown(w, word)).join(" ")}`);
      if (server.url) lines.push(`url: ${shown(server.url, (u) => u)}`);
      const env = Object.entries(server.env ?? {});
      if (env.length) lines.push(`env: ${env.map(([k, v]) => `${quoted(k)}=${envValue(k, v)}`).join(", ")}`);
      if (server.command) lines.push("The command runs on this computer, as you, whenever a session starts.");
      break;
    }
    case "mcp.enable":
    case "mcp.disable": {
      const current = obj(obj(state.settings.mcpServers)[input.name ?? ""]);
      lines.push(arrow(`MCP server ${t(input.name)}`, current.disabled === true ? "off" : "on", input.action === "mcp.enable" ? "on" : "off"));
      break;
    }
    case "mcp.edit": {
      const current = obj(state.settings.mcpServers)[input.name ?? ""];
      if (!isObject(current)) {
        lines.push(`(no MCP server named ${t(input.name)})`);
        break;
      }
      const change = input.server ?? {};
      const next = editedServer(current, change, change.env);
      const label = typeof next.url === "string" ? "url" : "command";
      lines.push(`MCP server ${t(input.name)}`);
      lines.push(`${label}: ${serverLine(current)} → ${serverLine(next)}`);
      const added = Object.entries(change.env ?? {});
      if (added.length) lines.push(`env: ${added.map(([k, v]) => `${quoted(k)}=${envValue(k, v)}`).join(", ")}`);
      const kept = Object.keys(obj(current.env)).filter((k) => !(k in (change.env ?? {})));
      if (kept.length && label === "command") lines.push(`kept: ${kept.map((k) => t(k)).join(", ")} (values not shown)`);
      if (label === "command") lines.push("The command runs on this computer, as you, whenever a session starts.");
      break;
    }
    case "mcp.remove": {
      const current = obj(state.settings.mcpServers)[input.name ?? ""];
      lines.push(isObject(current) ? `MCP server ${t(input.name)}: remove (${serverLine(current)})` : `(no MCP server named ${t(input.name)})`);
      lines.push("New sessions no longer start it.");
      break;
    }
    case "mcp.test": {
      const current = obj(state.settings.mcpServers)[input.name ?? ""];
      lines.push(isObject(current) ? `Start the MCP server ${t(input.name)} once to list its tools, then stop it: ${serverLine(current)}` : `(no MCP server named ${t(input.name)})`);
      break;
    }
    case "mcp.list":
      lines.push("List the MCP servers and whether they are connected. Read-only: nothing is changed.");
      break;
    case "plugin.install":
      lines.push(fetchLine(input.source, input.subdir));
      if (input.name) lines.push(`which: the plugin ${t(input.name)} from that marketplace (when the repository is one)`);
      lines.push(`into: ${join(state.home ?? "~/.tropos", "plugins")}/<its name>`);
      lines.push("Nothing from it runs now. If it has hooks or MCP servers it is installed switched off: turning it on is a separate approval that lists exactly what it runs.");
      break;
    case "plugin.enable":
    case "plugin.disable": {
      const plugin = state.home && input.name ? findPlugin(state.home, input.name) : undefined;
      if (!plugin) {
        lines.push(`(no plugin named ${t(input.name)})`);
        break;
      }
      const on = !disabledPlugins(state).includes(plugin.name);
      lines.push(arrow(`plugin ${plugin.name}`, on ? "on" : "off", input.action === "plugin.enable" ? "on" : "off"));
      lines.push(`its folder: ${t(plugin.root)}`);
      if (input.action === "plugin.disable") {
        lines.push("New sessions don't load its commands, skills, agents, hooks or MCP servers.");
        break;
      }
      const runs = pluginRuns(plugin);
      if (!runs.length) lines.push("It runs no programs: it adds commands, skills or agents.");
      else {
        lines.push("When on, it runs on this computer, as you:");
        for (const r of runs) lines.push(`- ${t(r.what)}: ${shown(r.text, (x) => x)}`);
      }
      break;
    }
    case "plugin.remove": {
      const plugin = state.home && input.name ? findPlugin(state.home, input.name) : undefined;
      lines.push(plugin ? `Delete the plugin ${plugin.name} and its folder ${t(plugin.root)}. This can't be undone.` : `(no plugin named ${t(input.name)})`);
      break;
    }
    case "plugin.list":
      lines.push("List the installed plugins and whether they are on. Read-only: nothing is changed.");
      break;
    case "skill.install": {
      lines.push(fetchLine(input.source, input.subdir));
      const dir = state.home ? resolveLayoutPath(state.home, "skills") : "your skills folder";
      lines.push(`into: ${t(dir)}/${input.name ? t(input.name) : "<the skill's name>"}`);
      lines.push("Every file is checked for injected instructions, secret leaks, fetch-and-run lines and hidden characters first. A skill is text your sessions follow; nothing in it runs now.");
      break;
    }
    case "download": {
      const url = input.url;
      const problem = url === undefined ? "no URL given" : (unshowable(url) && `it ${unshowable(url)}`) || downloadUrlProblem(url);
      lines.push(problem ? `download: (refused: ${problem})` : `download: ${url}`);
      const path = input.path ?? (url ? downloadName(url) : "?");
      lines.push(`save as: ${t(path)}${isAbsolute(path) ? "" : " (in this project's folder)"}`);
      lines.push(input.overwrite ? `It replaces the file at ${t(path)} if there is one.` : "It never replaces a file that is already there.");
      lines.push(`At most ${mb(MAX_DOWNLOAD_BYTES)}; you get its size and sha256. Nothing in it runs.`);
      break;
    }
    case "proactive.set": {
      const p = obj(state.gateway.proactive);
      if (input.enabled !== undefined) lines.push(arrow("proactive messages", proactiveOn(state) ? "on" : "off", input.enabled ? "on" : "off"));
      if (input.activeHours) {
        const h = obj(p.activeHours);
        lines.push(arrow("active hours", `${str(h.start, "09:00")}–${str(h.end, "21:00")}`, `${input.activeHours.start}–${input.activeHours.end}`));
      }
      if (input.everyHours !== undefined) lines.push(arrow("check every (hours)", p.everyHours ?? 4, input.everyHours));
      if (input.maxPerDay !== undefined) lines.push(arrow("messages per day at most", p.maxPerDay ?? 1, input.maxPerDay));
      if (!lines.length) lines.push("(nothing to change)");
      break;
    }
    case "messages.set":
      lines.push(arrow("texts (Messages)", state.settings.messages === true ? "on" : "off", input.enabled === undefined ? "?" : input.enabled ? "on" : "off"));
      if (input.enabled) lines.push("Turning it on builds a small helper app; macOS then asks for Full Disk Access and Automation. It reads and sends only what you approve.");
      break;
    case "autonomy.lower": {
      const to = input.level ?? "?";
      if (input.project) {
        const p = projectsOf(state).find((x) => x.id === input.project);
        lines.push(arrow(`autonomy (${t(input.project)})`, str(p?.autonomy, str(obj(state.gateway.chat).autonomy, "balanced")), to));
      } else {
        lines.push(arrow("autonomy", str(obj(state.gateway.chat).autonomy, "balanced"), to));
        for (const p of projectsOf(state)) {
          const own = typeof p.autonomy === "string" ? p.autonomy : undefined;
          if (own !== undefined && (RANK[own] ?? 0) > (RANK[to] ?? 0)) lines.push(`  ${t(p.id)}: ${own} → ${to}`);
        }
      }
      break;
    }
    case "doctor.run":
      lines.push("Run the doctor's checks. Read-only: nothing is changed.");
      break;
    case "doctor.fix":
      lines.push(`Apply the doctor's fix for ${t(input.finding)}.`);
      break;
    case "service.restart":
      lines.push("Restart the background service. Open chats pause for a few seconds.");
      break;
    case "tropos.update":
      lines.push("Update Tropos to the latest release, then restart the background service if it runs.");
      break;
  }
  return { header, text: lines.join("\n") };
}
