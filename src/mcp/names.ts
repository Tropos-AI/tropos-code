// src/mcp/names.ts

/** The Messages API caps tool names at 64 characters of [A-Za-z0-9_-]. */
const MAX_TOOL_NAME = 64;
const PREFIX = "mcp__";
const SEPARATOR = "__";

function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Longest server name: leaves room for a tool part, so the server part is never cut. */
export const MAX_SERVER_NAME = 32;
const HASH_CHARS = 6;

/**
 * The tool name the model sees for `tool` on `server`: `mcp__<server>__<tool>`. Characters the API
 * rejects become `_`. The server part is never cut (names are capped at MAX_SERVER_NAME and can't
 * contain "__"), so a server can't land inside another server's `mcp__<server>` permission rule.
 * Over 64 chars, the tool part is cut and ends in a short hash of the full name, so long names stay
 * distinct. McpManager keeps the first tool with a given name.
 */
export function mcpToolName(server: string, tool: string): string {
  const s = (sanitize(server) || "_").slice(0, MAX_SERVER_NAME);
  let t = sanitize(tool) || "_";
  const room = MAX_TOOL_NAME - PREFIX.length - SEPARATOR.length - s.length;
  if (t.length > room) {
    const hash = new Bun.CryptoHasher("sha256").update(tool).digest("hex").slice(0, HASH_CHARS);
    t = `${t.slice(0, room - HASH_CHARS - 1)}_${hash}`;
  }
  return `${PREFIX}${s}${SEPARATOR}${t}`;
}

/**
 * Expands `${VAR}` and `${VAR:-default}` from `env`, the way a shell does: an unset variable becomes
 * the empty string, and `:-` also falls back when the variable is set but empty. Settings use this for
 * secrets (`"Authorization": "Bearer ${GITHUB_TOKEN}"`) so tokens stay out of settings files.
 */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    const current = env[name];
    if (fallback !== undefined && (current === undefined || current === "")) return fallback;
    return current ?? "";
  });
}
