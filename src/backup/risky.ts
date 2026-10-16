// src/backup/risky.ts — which files of a backup can run code or let people in. A backup is only as trustworthy as
// whoever made it, so restoring these needs an explicit "I trust this" (restoreBackup's trustCode).

export interface RiskyFile {
  path: string;
  why: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== false);

const SETTINGS = /^(settings\.json|projects\/[^/]+\/settings\.json)$/;

function settingsWhy(text: string | undefined): string | undefined {
  // Unreadable here means the restore is refused later by schema validation; flagged anyway so nothing slips by.
  let json: unknown;
  try {
    json = JSON.parse(text ?? "");
  } catch {
    return "settings that could not be read";
  }
  if (!isObj(json)) return "settings that could not be read";
  const found: string[] = [];
  if (nonEmpty(json.hooks)) found.push("hooks (commands run on events)");
  if (nonEmpty(json.mcpServers)) found.push("MCP servers (programs started for you)");
  if (nonEmpty(json.env)) found.push("environment variables");
  if (nonEmpty(json.providers)) found.push("model providers (where your prompts are sent)");
  if (isObj(json.permissions) && nonEmpty(json.permissions.allow)) found.push("permission allow rules (commands that run without asking)");
  return found.length ? `settings with ${found.join(", ")}` : undefined;
}

function gatewayWhy(text: string | undefined): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text ?? "");
  } catch {
    return "gateway settings that could not be read";
  }
  if (!isObj(json)) return "gateway settings that could not be read";
  const found: string[] = [];
  if (isObj(json.telegram) && nonEmpty(json.telegram.botToken)) found.push("a bot token");
  if (isObj(json.sandbox) && (json.sandbox.image !== undefined || json.sandbox.network !== undefined)) found.push("the sandbox image or network");
  if (nonEmpty(json.projects)) found.push("projects (folders chats can work in)");
  return found.length ? `gateway settings with ${found.join(", ")}` : undefined;
}

/**
 * The files among `files` that can run code or let people in, each with the reason. `read` gives the text of the files
 * whose content decides it (settings.json, gateway.json, projects/<k>/settings.json); the rest are risky by where they are.
 */
export function classifyRisky(files: { path: string }[], read: (path: string) => string | undefined): RiskyFile[] {
  const out: RiskyFile[] = [];
  for (const { path } of files) {
    let why: string | undefined;
    if (SETTINGS.test(path)) why = settingsWhy(read(path));
    else if (path === "gateway.json") why = gatewayWhy(read(path));
    else if (path === "gateway/pairing.json") why = "the list of people allowed to talk to the gateway";
    else if (path.startsWith("gateway/cron/")) why = "scheduled prompts that run on their own";
    else if (path.startsWith("skills/")) why = "a skill: instructions (and possibly scripts) the agent follows";
    else if (path.startsWith("plugins/")) why = "a plugin: code and instructions the agent loads";
    else if (path === "SOUL.md" || path === "TROPOS.md" || path === "IDENTITY.md") why = "instructions the agent follows in every session";
    if (why) out.push({ path, why });
  }
  return out;
}

/** Files whose text classifyRisky and restore validation need. */
export const INSPECTED = (path: string): boolean => SETTINGS.test(path) || path === "gateway.json";
