// src/gateway/policy.ts — what a session started from a messaging channel may do (spec §2.3).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { Mode } from "../config/constants";
import { isInside } from "../paths";
import { compileRules } from "../permissions/engine";
import type { AppContext } from "../cli/runtime";
import type { ExecBackend } from "../exec/backend";

/** The only modes a chat can be in: never `bypass`, and nothing that silently accepts edits. */
export const CHANNEL_MODES: Mode[] = ["default", "plan"];

/**
 * Tools a chat doesn't get. SessionSearch reads the owner's other transcripts (terminal, web and other chats share the
 * project's session folder), none of which is the chat's business. WebFetch runs on the host with no guard against
 * loopback, LAN and metadata addresses; until web access goes through the sandbox, a chat has none.
 */
const WITHHELD_TOOLS = new Set(["SessionSearch", "WebFetch"]);

/**
 * Tools whose effects leave the sandbox. They always ask in a chat, even when the user's own settings
 * allow them elsewhere: an ask rule outranks an allow rule in the permission engine.
 */
const ALWAYS_ASK = ["mcp__*"];

/**
 * The context for one chat's session: the gateway's workspace context, narrowed. It never widens anything:
 * the base rules and settings are the user's own, and what is changed only restricts.
 */
export function channelContext(base: AppContext, exec: ExecBackend): AppContext {
  const forced = compileRules({ allow: [], ask: ALWAYS_ASK, deny: [] }).rules;
  return {
    ...base,
    origin: "channel",
    exec,
    tools: base.tools.filter((t) => !WITHHELD_TOOLS.has(t.name)),
    // Formatters and language servers run on the host and load config from the project, which a sandboxed command can
    // write without the write guard noticing.
    ext: { ...base.ext, formatters: null, lsp: null },
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
      // The background review writes notes and skills from what the chat said; chat text is untrusted.
      learning: { ...base.settings.learning, review: false, curator: false },
    },
  };
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
