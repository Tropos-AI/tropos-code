// src/doctor/checks/mcp.ts — the command of each stdio MCP server in the user's settings exists.
import { readSettingsFile } from "../../config/settings";
import type { Check } from "../types";
import { findOnPath, finding } from "../util";

export const mcpCheck: Check = {
  id: "mcp.servers",
  area: "mcp",
  title: "MCP server commands exist",
  async run(env) {
    let servers: NonNullable<Awaited<ReturnType<typeof readSettingsFile>>>["mcpServers"];
    try {
      servers = (await readSettingsFile(`${env.home}/settings.json`))?.mcpServers;
    } catch {
      return []; // the settings check reports it
    }
    const entries = Object.entries(servers ?? {}).filter(([, s]) => !s.disabled);
    if (entries.length === 0) return [finding("mcp.servers", "ok", "No MCP servers configured")];
    const out = [];
    for (const [name, s] of entries) {
      if ("url" in s) {
        out.push(finding(`mcp.servers.${name}`, "ok", `${name}: ${s.type} server at ${s.url.replace(/\?.*$/, "")}`));
        continue;
      }
      const found = findOnPath(s.command, s.cwd ? `${s.cwd}:${env.env.PATH ?? ""}` : env.env.PATH);
      out.push(
        found
          ? finding(`mcp.servers.${name}`, "ok", `${name}: ${s.command} found`)
          : finding(`mcp.servers.${name}`, "warn", `${name}: command \`${s.command}\` is not on PATH`, { detail: "The server will fail to start; install it or give a full path." }),
      );
    }
    return out;
  },
};
