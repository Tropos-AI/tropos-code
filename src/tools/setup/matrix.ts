// src/tools/setup/matrix.ts — what TroposSetup can do, and who may ask for it (spec doc 2, Part H).
// Raising autonomy, remote access, pairing approvals, permission rules, hooks and the sandbox are not actions at all:
// they stay in the dashboard and the CLI, so no surface can reach them through this tool.
import { z } from "zod";
import { AUTONOMY_LEVELS } from "../../gateway/config";
import type { SessionRole } from "../../gateway/types";
import { EFFORTS } from "../../config/constants";
import { findSecrets } from "./secrets";

export const SETUP_ACTIONS = [
  "telegram.connect",
  "telegram.disconnect",
  "project.add",
  "project.create",
  "project.rename",
  "project.remove",
  "project.default",
  "model.set",
  "provider.connect",
  "mcp.add",
  "mcp.enable",
  "mcp.disable",
  "proactive.set",
  "autonomy.lower",
  "doctor.run",
  "doctor.fix",
  "service.restart",
  "tropos.update",
] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

/** Who is asking: their role, and whether they sit at the computer (terminal, dashboard) or in a chat. */
export interface SetupWho {
  role: SessionRole;
  origin: "local" | "channel";
}

/** A refusal whose message is meant for the owner (it carries the dashboard pointer). */
export class SetupRefused extends Error {}

export const OWNER_ONLY = "Only the owner can change Tropos's setup.";
export const CHAT_DOCTOR_READ_ONLY = "In a chat the doctor is read-only: I can run it and tell you what it found, but its fixes are applied in the dashboard (Status → Health).";

const KNOWN: ReadonlySet<string> = new Set(SETUP_ACTIONS);

export function setupDecision(action: SetupAction, who: SetupWho): { ok: true } | { ok: false; reason: string } {
  if (!KNOWN.has(action)) return { ok: false, reason: `There is no setup action "${String(action)}".` };
  // Guests, scheduled runs (and specialists, which never get the tool at all) change nothing.
  if (who.role !== "owner") return { ok: false, reason: OWNER_ONLY };
  if (who.origin === "channel" && action === "doctor.fix") return { ok: false, reason: CHAT_DOCTOR_READ_ONLY };
  return { ok: true };
}

// Variables that make the server's interpreter or loader run other code (or read config from elsewhere). An approval
// prompt in a chat is too easy to wave through for these: such a server is added in Settings → Extensions.
const LOADER_VARIABLES: ReadonlySet<string> = new Set(["NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "PATH", "PYTHONPATH", "PYTHONSTARTUP", "RUBYOPT", "PERL5OPT", "BASH_ENV", "ENV", "ZDOTDIR"]);
const LOADER_PREFIXES = ["DYLD_", "GIT_"];

export function isLoaderVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return LOADER_VARIABLES.has(upper) || LOADER_PREFIXES.some((p) => upper.startsWith(p));
}

// The names and shapes the config store treats as secrets (src/config/store.ts), plus the vault's own patterns.
const SECRET_NAME = /(^|[-_])(api[-_]?key|token|password|passwd|secret|key|authorization|credentials?)$|(apikey|token|password|secret)$/i;
const SECRET_SHAPE = /^(xox[abprs]-|gh[pousr]_|github_pat_|Bearer\s)/;
export const SECRET_REF = /^secret:\d+$/;

/** A raw value that is (or is named like) a key: it must come from the vault as a secret:<n> ref instead. */
export function looksSecret(name: string, value: string): boolean {
  return !SECRET_REF.test(value) && (SECRET_NAME.test(name) || SECRET_SHAPE.test(value) || findSecrets(value).length > 0);
}

/** Why the tool won't add a server with this env, or undefined. `extensions` is the dashboard link to send the owner to. */
export function mcpEnvProblem(env: Record<string, string>, extensions: string): string | undefined {
  const loaders = Object.keys(env).filter(isLoaderVariable);
  if (loaders.length) {
    return `I won't set ${loaders.join(", ")} for an MCP server from here: they change what the server's program loads and runs. Add such a server in Settings → Extensions instead: ${extensions}`;
  }
  const raw = Object.entries(env).filter(([k, v]) => looksSecret(k, v)).map(([k]) => k);
  if (raw.length) return `${raw.join(", ")} looks like a key. Paste the key in this chat on its own so I can hold it, then use its secret:<n> ref.`;
  return undefined;
}

const serverSchema = z.object({
  type: z.enum(["stdio", "http", "sse"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional().describe("Values may be secret:<n> refs from the conversation."),
});

/** Flat, like Cron's: each action reads the fields it needs. */
export const setupInputSchema = z.object({
  action: z.enum(SETUP_ACTIONS),
  project: z.string().optional().describe("A project id: project.rename, project.remove, project.default, autonomy.lower (one project)."),
  name: z.string().optional().describe("project.create / project.add / project.rename: the project's name. mcp.*: the server's name."),
  path: z.string().optional().describe("project.add: the folder to register."),
  model: z.string().optional().describe('model.set: e.g. "anthropic/claude-opus-5-5".'),
  effort: z.enum(EFFORTS).optional().describe("model.set: the reasoning effort."),
  provider: z.string().optional().describe('provider.connect: the provider id, e.g. "anthropic", "openai".'),
  secret: z.string().optional().describe("telegram.connect / provider.connect: the secret:<n> ref of the key the user pasted. Never the key itself."),
  server: serverSchema.optional().describe("mcp.add: the server to add."),
  enabled: z.boolean().optional().describe("proactive.set: messages I start myself on or off."),
  activeHours: z.object({ start: z.string(), end: z.string() }).optional().describe('proactive.set: e.g. {"start":"09:00","end":"21:00"}; quiet outside.'),
  everyHours: z.number().optional().describe("proactive.set: how often I check whether something is worth a message."),
  maxPerDay: z.number().optional().describe("proactive.set: at most this many messages a day (0-3)."),
  level: z.enum(AUTONOMY_LEVELS).optional().describe("autonomy.lower: the stricter level. Raising is never possible here."),
  finding: z.string().optional().describe("doctor.fix: the finding id from doctor.run."),
});
export type SetupInput = z.infer<typeof setupInputSchema>;
