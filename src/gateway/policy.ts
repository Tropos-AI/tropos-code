// src/gateway/policy.ts — what a session started from a messaging channel may do (spec §2.3).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { Mode } from "../config/constants";
import { isInside } from "../paths";
import { STORE_TOOLS } from "../learning/stores";
import { compileRules, type AutonomyPolicy } from "../permissions/engine";
import type { AppContext } from "../cli/runtime";
import type { ExecBackend } from "../exec/backend";
import { privateTelegramSender } from "./revocation";
import type { Pairing, SessionRole } from "./types";

/** The only modes a chat can be in: never `bypass`, and nothing that silently accepts edits. */
export const CHANNEL_MODES: Mode[] = ["default", "plan"];

/**
 * Tools no chat gets. WebFetch runs on the host with no guard against loopback, LAN and metadata addresses; until web
 * access goes through the sandbox, a chat has none.
 */
const WITHHELD_TOOLS = new Set(["WebFetch"]);

/**
 * SessionSearch reads the owner's other transcripts, which are nobody else's business. The store tools save under the
 * Tropos home, which confinement denies to everyone but the owner: elsewhere they could never succeed.
 */
const OWNER_ONLY_TOOLS: ReadonlySet<string> = new Set(["SessionSearch", ...STORE_TOOLS]);

/** Which role a chat key runs as: scheduled runs, the owner's own private chat, or a guest (groups and guests' jobs included). */
export async function chatRole(chatKey: string, pairing: Pick<Pairing, "isOwner">): Promise<SessionRole> {
  // project:<id>:guest runs a job made in a guest's chat: its text is a guest's (src/gateway/cron/runner.ts).
  if (chatKey.startsWith("project:")) return chatKey.endsWith(":guest") ? "guest" : "scheduled";
  const sender = privateTelegramSender(chatKey);
  return sender !== undefined && (await pairing.isOwner("telegram", sender)) ? "owner" : "guest";
}

/**
 * Tools whose effects leave the sandbox. They always ask in a chat, even when the user's own settings
 * allow them elsewhere: an ask rule outranks an allow rule in the permission engine. TroposSetup changes Tropos itself
 * (channels, projects, keys, MCP commands), so no autonomy level lets it run unasked.
 */
const ALWAYS_ASK = ["mcp__*", "TroposSetup"];

/**
 * The context for one chat's session: the gateway's workspace context, narrowed. It never widens anything:
 * the base rules and settings are the user's own, and what is changed only restricts. The one thing that lets work
 * run unasked is `autonomy`, read on every decision so a changed level applies to the open session.
 */
export function channelContext(base: AppContext, exec: ExecBackend, opts: { role: SessionRole; autonomy?: () => AutonomyPolicy }): AppContext {
  const { role } = opts;
  const forced = compileRules({ allow: [], ask: ALWAYS_ASK, deny: [] }).rules;
  return {
    ...base,
    origin: "channel",
    role,
    exec,
    autonomy: opts.autonomy,
    tools: base.tools.filter((t) => !WITHHELD_TOOLS.has(t.name) && (role === "owner" || !OWNER_ONLY_TOOLS.has(t.name))),
    // Formatters and language servers run on the host and load config from the project, which a sandboxed command can
    // write without the write guard noticing. The owner's notes and journal are private: a guest's chat or a scheduled
    // run never sees them in its context.
    ext: { ...base.ext, formatters: null, lsp: null, ...(role === "owner" ? {} : { notes: null, daily: null }) },
    rules: {
      // The owner's allow rules are for the person at the keyboard: `Bash(npm:*)` or `Edit` must not make a chat's
      // commands and writes run unasked. Reads inside the workspace need no rule.
      allow: [],
      ask: [...base.rules.ask, ...forced.ask],
      deny: [...base.rules.deny],
    },
    // The workspace and nothing else: --add-dir and additionalDirectories are for the person at the keyboard.
    allowedDirs: [base.cwd],
    settings: {
      ...base.settings,
      // The owner's own chat keeps the background review; a guest's or a scheduled run's text is untrusted. The curator
      // is never per chat: the gateway runs it as a service.
      learning: role === "owner" ? { ...base.settings.learning, curator: false } : { ...base.settings.learning, review: false, curator: false },
    },
  };
}

/** A runtime the gateway hosts outside a chat (the dashboard's) never runs the curator: the gateway's service owns it. */
export function gatewayHosted(ctx: AppContext): AppContext {
  return { ...ctx, settings: { ...ctx.settings, learning: { ...ctx.settings.learning, curator: false } } };
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Why a directory can't be a chat workspace, or undefined when it can. The workspace is mounted into the container and
 * is what the file tools may touch, so it must not hold the owner's credentials or Tropos's own settings: that is
 * the home directory itself (or a parent of it), `~/.tropos`, or the filesystem root.
 */
export function workspaceProblem(workspace: string, troposHome: string, userHome: string = homedir()): string | undefined {
  const dir = real(workspace);
  if (dirname(dir) === dir) return "the filesystem root can't be a workspace";
  for (const [label, protectedDir] of [
    ["your home directory", real(userHome)],
    ["Tropos's data directory", real(troposHome)],
  ] as const) {
    if (isInside(protectedDir, dir)) return `${workspace} is, or contains, ${label}; pick a project directory`;
  }
  if (isInside(dir, real(troposHome))) return `${workspace} is inside Tropos's data directory; pick a project directory`;
  return undefined;
}
