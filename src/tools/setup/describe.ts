// src/tools/setup/describe.ts — the permission preview of a setup change: exactly what changes, as "before → after".
// It never shows a secret: keys are named by their secret:<n> ref, anything else in an MCP env is hidden.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatewayConfigPath } from "../../gateway/config";
import type { PermissionPreview } from "../types";
import type { SetupInput } from "./matrix";

export type SetupState = { settings: Record<string, unknown>; gateway: Record<string, unknown> };

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

const SECRET_REF = /^secret:\d+$/;
const RANK: Record<string, number> = { ask: 0, balanced: 1, autonomous: 2 };

const obj = (v: unknown): Json => (isObject(v) ? v : {});
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);
const projectsOf = (s: SetupState): Json[] => (Array.isArray(s.gateway.projects) ? s.gateway.projects.filter(isObject) : []);
const arrow = (label: string, before: unknown, after: unknown): string => `${label}: ${String(before)} → ${String(after)}`;

/** A key the request carries: its ref, or that one was pasted (a raw value is never repeated). */
const keyNote = (secret: string | undefined): string => (secret === undefined ? "(no key given)" : SECRET_REF.test(secret) ? `(${secret}, not shown)` : "(pasted key, not shown)");

/** One shell word, quoted when it needs to be, so the approval shows the command that will run. */
const word = (w: string): string => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function proactiveOn(s: SetupState): boolean {
  const enabled = obj(s.gateway.proactive).enabled;
  if (typeof enabled === "boolean") return enabled;
  // Unset follows Telegram: on once a bot is connected.
  return typeof obj(s.gateway.telegram).botToken === "string";
}

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
      lines.push(`projects: add ${input.path ?? "(no folder given)"}${input.name ? ` as "${input.name}"` : ""}`);
      break;
    case "project.create":
      lines.push(`projects: create a folder "${input.name ?? ""}" in ${str(state.gateway.newProjectsDir, "~/Projects")}, run git init and add it as a project`);
      break;
    case "project.rename": {
      const p = projectsOf(state).find((x) => x.id === input.project);
      lines.push(arrow(`project ${input.project ?? "?"} name`, p ? str(p.name, "?") : "(unknown project)", input.name ?? "?"));
      break;
    }
    case "project.remove": {
      const p = projectsOf(state).find((x) => x.id === input.project);
      lines.push(`projects: remove ${input.project ?? "?"}${p ? ` (${str(p.path, "?")})` : ""}; the folder itself stays on disk`);
      break;
    }
    case "project.default":
      lines.push(arrow("default project", str(state.gateway.defaultProject, "default"), input.project ?? "?"));
      break;
    case "model.set":
      if (input.model !== undefined) lines.push(arrow("model", str(state.settings.model, "(default)"), input.model));
      if (input.effort !== undefined) lines.push(arrow("effort", str(state.settings.effort, "(default)"), input.effort));
      if (!lines.length) lines.push("(nothing to change)");
      lines.push("New sessions use it; open conversations keep their model until /new.");
      break;
    case "provider.connect":
      lines.push(`provider ${input.provider ?? "?"}: connect with the API key ${keyNote(input.secret)}`);
      break;
    case "mcp.add": {
      const server = input.server ?? {};
      const exists = isObject(obj(state.settings.mcpServers)[input.name ?? ""]);
      lines.push(`MCP server ${input.name ?? "?"}: ${exists ? "already exists (it is not replaced)" : "add"}`);
      lines.push(`type: ${server.type ?? (server.url ? "http" : "stdio")}`);
      if (server.command) lines.push(`command: ${[server.command, ...(server.args ?? [])].map(word).join(" ")}`);
      if (server.url) lines.push(`url: ${server.url}`);
      const env = Object.entries(server.env ?? {});
      if (env.length) lines.push(`env: ${env.map(([k, v]) => `${k}=${SECRET_REF.test(v) ? `(${v})` : "(hidden)"}`).join(", ")}`);
      if (server.command) lines.push("The command runs on this computer, as you, whenever a session starts.");
      break;
    }
    case "mcp.enable":
    case "mcp.disable": {
      const current = obj(obj(state.settings.mcpServers)[input.name ?? ""]);
      lines.push(arrow(`MCP server ${input.name ?? "?"}`, current.disabled === true ? "off" : "on", input.action === "mcp.enable" ? "on" : "off"));
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
    case "autonomy.lower": {
      const to = input.level ?? "?";
      if (input.project) {
        const p = projectsOf(state).find((x) => x.id === input.project);
        lines.push(arrow(`autonomy (${input.project})`, str(p?.autonomy, str(obj(state.gateway.chat).autonomy, "balanced")), to));
      } else {
        lines.push(arrow("autonomy", str(obj(state.gateway.chat).autonomy, "balanced"), to));
        for (const p of projectsOf(state)) {
          const own = typeof p.autonomy === "string" ? p.autonomy : undefined;
          if (own !== undefined && (RANK[own] ?? 0) > (RANK[to] ?? 0)) lines.push(`  ${String(p.id)}: ${own} → ${to}`);
        }
      }
      break;
    }
    case "doctor.run":
      lines.push("Run the doctor's checks. Read-only: nothing is changed.");
      break;
    case "doctor.fix":
      lines.push(`Apply the doctor's fix for ${input.finding ?? "?"}.`);
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
