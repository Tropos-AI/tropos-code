// src/doctor/checks/security-settings.ts — broad allow rules, bypass defaults, hooks and MCP servers in the user's settings.
import { readFile } from "node:fs/promises";
import { SettingsError, readSettingsFile, settingsPaths } from "../../config/settings";
import type { Check, Finding } from "../types";
import { errorText, finding, isRecord } from "../util";

const BROAD_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** `Bash`, `Bash(*)`, `Edit`, `Write(**)` or a tool name with a wildcard allow everything the tool can do. */
export function isBroadRule(rule: string): boolean {
  const m = /^([^()]+?)\s*(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const name = m[1]!.trim();
  const arg = m[2]?.trim();
  if (name === "*") return true;
  if (arg === undefined || arg === "*" || arg === "**") return BROAD_TOOLS.has(name) || name.includes("*");
  return false;
}

/** Any key or value in the raw settings that selects the bypass mode. */
function mentionsBypass(value: unknown): boolean {
  if (typeof value === "string") return value === "bypass" || value === "bypassPermissions";
  if (Array.isArray(value)) return value.some(mentionsBypass);
  if (isRecord(value)) return Object.entries(value).some(([k, v]) => /dangerously|bypass/i.test(k) || mentionsBypass(v));
  return false;
}

export const securitySettingsCheck: Check = {
  id: "security.settings",
  area: "security",
  audit: true,
  title: "Permission settings",
  async run(env) {
    const paths = settingsPaths(env.cwd, env.home);
    const out: Finding[] = [];
    const broad: string[] = [];
    for (const [label, path] of [["user", paths.user], ["user project", paths.userProject], ["local", paths.local]] as const) {
      try {
        for (const rule of (await readSettingsFile(path))?.permissions?.allow ?? []) if (isBroadRule(rule)) broad.push(`${rule} (${label})`);
      } catch (err) {
        out.push(finding(`security.settings.${label.replace(" ", "-")}`, "warn", `${path} could not be read`, { detail: err instanceof SettingsError ? err.message : errorText(err) }));
      }
    }
    out.push(
      broad.length
        ? finding("security.settings.allow", "warn", `Broad allow rules: ${broad.join(", ")}`, { detail: "They let the agent act without asking. Narrow them, for example Bash(git status:*) instead of Bash." })
        : finding("security.settings.allow", "ok", "No allow rule grants a whole tool"),
    );

    const raw = await readFile(paths.user, "utf8").then((t) => JSON.parse(t) as unknown, () => undefined);
    out.push(
      mentionsBypass(raw)
        ? finding("security.settings.bypass", "warn", "settings.json selects the bypass permission mode", { detail: "Bypass skips every permission prompt. It is meant for a flag on one run, not a default." })
        : finding("security.settings.bypass", "ok", "Permission prompts are not bypassed by default"),
    );

    const settings = await readSettingsFile(paths.user).catch(() => null);
    const hooks = Object.entries(settings?.hooks ?? {}).flatMap(([event, matchers]) => (matchers ?? []).flatMap((m) => m.hooks.map((h) => `${event}: ${h.command}`)));
    if (hooks.length) out.push(finding("security.settings.hooks", "info", `${hooks.length} hook${hooks.length === 1 ? "" : "s"} defined`, { detail: hooks.join("\n") }));
    const mcp = Object.entries(settings?.mcpServers ?? {}).map(([name, s]) => `${name} (${"url" in s ? s.url.replace(/\?.*$/, "") : s.command})`);
    if (mcp.length) out.push(finding("security.settings.mcp", "info", `${mcp.length} MCP server${mcp.length === 1 ? "" : "s"}: ${mcp.join(", ")}`, { detail: "Their tools run with your permissions; only list servers you trust." }));
    return out;
  },
};
