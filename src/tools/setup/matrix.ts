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

// The only env entries TroposSetup adds: a key-like name whose value is a vault ref. Anything else (loader and
// interpreter variables above all) changes what the server's program runs; that is set in Settings → Extensions.
const KEY_NAME = /^[A-Z][A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PAT|API_KEY)$/;
export const SECRET_REF = /^secret:\d+$/;
export const OTHER_ENV = "Add servers that need other environment settings from Settings → Extensions.";

/** True for an env entry the tool may write: a key-like name and a secret:<n> ref. */
export function allowedEnvEntry(name: string, value: string): boolean {
  return KEY_NAME.test(name) && SECRET_REF.test(value);
}

/** The longest command, argument, URL or env value the approval shows; anything longer is refused, never cut. */
export const MAX_SHOWN = 200;
// Control, format (bidi, zero-width) and line/paragraph separators, or anything non-ASCII, could make the approval
// show something other than what runs.
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[^\x20-\x7e]/u;

// The names and shapes the config store treats as secrets (src/config/store.ts), plus the vault's own patterns.
const SECRET_NAME = /(^|[-_])(api[-_]?key|token|password|passwd|secret|key|authorization|credentials?|pat)$|(apikey|token|password|secret)$/i;
const SECRET_SHAPE = /^(xox[abprs]-|gh[pousr]_|github_pat_|Bearer\s)/;

/** A raw value that is (or is named like) a key: never shown, and it must come from the vault as a secret:<n> ref. */
export function looksSecret(name: string, value: string): boolean {
  return !SECRET_REF.test(value) && (SECRET_NAME.test(name) || SECRET_SHAPE.test(value) || findSecrets(value).length > 0);
}

/** Why a text can't be shown faithfully in the approval, or undefined. */
export function unshowable(text: string): string | undefined {
  if (UNSHOWABLE.test(text)) return "holds a line break, a control or invisible character, or a non-ASCII character";
  if (text.length > MAX_SHOWN) return `is longer than ${MAX_SHOWN} characters`;
  return undefined;
}

// Names, paths and ids may be in any script (a project called "Εργασία"), but nothing that hides or reorders text.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Why a name, path or id can't be shown faithfully in the approval, or undefined. */
export function unshowableText(text: string): string | undefined {
  if (HIDDEN.test(text)) return "holds a line break, a control or invisible character";
  if (text.length > MAX_SHOWN) return `is longer than ${MAX_SHOWN} characters`;
  return undefined;
}

const TEXT_FIELDS = [
  ["project", "The project id"],
  ["name", "The name"],
  ["path", "The folder"],
  ["model", "The model"],
  ["provider", "The provider"],
  ["finding", "The finding id"],
] as const;

/** Why the request's own text can't be shown in the approval (and so is refused), or undefined. */
export function setupTextProblem(input: Partial<Record<(typeof TEXT_FIELDS)[number][0], string>>): string | undefined {
  for (const [field, what] of TEXT_FIELDS) {
    const value = input[field];
    const why = value === undefined ? undefined : unshowableText(value);
    if (why) return `${what} ${why}, so I can't show it to you for approval. Make this change in the dashboard instead.`;
  }
  return undefined;
}

type ServerInput = { command?: string; args?: string[]; url?: string; env?: Record<string, string> };

/**
 * Why the tool won't add this server, or undefined: everything that will run is shown in the approval exactly as it
 * is, and the env holds vault keys only. `extensions` is the dashboard link for anything else.
 */
export function mcpServerProblem(server: ServerInput, extensions: string): string | undefined {
  const parts: [string, string | undefined][] = [["The command", server.command], ...(server.args ?? []).map((a, i): [string, string] => [`Argument ${i + 1}`, a]), ["The URL", server.url]];
  for (const [what, text] of parts) {
    const why = text === undefined ? undefined : unshowable(text);
    if (why) return `${what} ${why}, so I can't show it to you for approval. Add this server in Settings → Extensions instead: ${extensions}`;
  }
  const refused = Object.entries(server.env ?? {}).filter(([k, v]) => !allowedEnvEntry(k, v)).map(([k]) => (/^[\x21-\x7e]{1,64}$/.test(k) ? k : JSON.stringify(k.slice(0, 64))));
  if (refused.length) {
    return `I can only set keys held in the vault (a name like GITHUB_TOKEN with a secret:<n> ref), not ${refused.join(", ")}. ${OTHER_ENV} ${extensions}`;
  }
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
