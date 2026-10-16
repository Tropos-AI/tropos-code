// src/gateway/autonomy.ts — how freely a chat's agent acts, and the only writers of that setting.
// Imports config.ts only (the schema lives there) so the two modules never form an import cycle.
import { readFile } from "node:fs/promises";
import type { Confinement } from "../exec/backend";
import { AUTONOMY_LEVELS, type Autonomy, type GatewayConfig, gatewayConfigPath, loadGatewayConfig, saveGatewayConfig } from "./config";
import { UserFacingError } from "./errors";
import type { SessionRole } from "./types";

export { AUTONOMY_LEVELS };
export type { Autonomy };

export const UNCONFINED_CONSENT =
  "Commands can't be confined on this machine (no sandbox-exec or bwrap), so at this level chat commands would run unconfined as you. Confirm \"run unconfined\" to go ahead.";
export const RAISE_REFUSED = "A chat can only lower the autonomy level. Raise it on the computer: tcode config or the dashboard.";

export class AutonomyError extends UserFacingError {}

const RANK: Record<Autonomy, number> = { ask: 0, balanced: 1, autonomous: 2 };

/** The project's own level, else the global one. Built-in and unknown projects have no entry, so get the global one. */
export function effectiveAutonomy(config: GatewayConfig, projectId: string): Autonomy {
  return config.projects.find((p) => p.id === projectId)?.autonomy ?? config.chat.autonomy;
}

/** True when `to` is as strict as `from` or stricter: the only direction a chat may move a level. */
export function canRaise(from: Autonomy, to: Autonomy): boolean {
  return RANK[to] <= RANK[from];
}

export function pinnedTestCommands(config: GatewayConfig, projectId: string): string[] {
  return config.projects.find((p) => p.id === projectId)?.testCommands ?? [];
}

/** The level a session actually runs at: guests never leave `ask`, and neither does anyone unconfined without consent. */
export function sessionAutonomy(input: { config: GatewayConfig; projectId: string; role: SessionRole; confined: boolean }): Autonomy {
  if (input.role === "guest") return "ask";
  if (!input.confined && !input.config.chat.allowUnconfined) return "ask";
  return effectiveAutonomy(input.config, input.projectId);
}

/** Host commands with no OS confinement and no recorded consent, while any level would let them run unasked. */
export function needsUnconfinedConsent(config: GatewayConfig, confinement: Confinement | null): boolean {
  if (config.chat.backend !== "host" || confinement !== null || config.chat.allowUnconfined) return false;
  return config.chat.autonomy !== "ask" || config.projects.some((p) => p.autonomy !== undefined && p.autonomy !== "ask");
}

/** Applies the consent rule to a changed config; a yes is recorded so it is asked once. */
function checkConsent(next: GatewayConfig, confinement: Confinement | null, accept: boolean | undefined): GatewayConfig {
  if (!needsUnconfinedConsent(next, confinement)) return next;
  if (!accept) throw new AutonomyError(UNCONFINED_CONSENT);
  return { ...next, chat: { ...next.chat, allowUnconfined: true } };
}

function isBuiltIn(projectId: string): boolean {
  return projectId === "default" || projectId === "cwd";
}

export async function setAutonomy(
  home: string,
  input: { projectId?: string; level: Autonomy | null; acceptUnconfined?: boolean; confinement: Confinement | null },
): Promise<GatewayConfig> {
  const config = await loadGatewayConfig(home);
  let next: GatewayConfig;
  if (input.projectId === undefined) {
    if (input.level === null) throw new AutonomyError("The global autonomy level can be changed but not cleared.");
    next = { ...config, chat: { ...config.chat, autonomy: input.level } };
  } else {
    const id = input.projectId;
    if (isBuiltIn(id)) {
      if (input.level !== null) throw new AutonomyError(`The ${id} workspace follows the global level; set that instead.`);
    }
    if (!config.projects.some((p) => p.id === id)) throw new AutonomyError(`No project "${id}".`);
    next = {
      ...config,
      projects: config.projects.map((p) => {
        if (p.id !== id) return p;
        const { autonomy: _old, ...rest } = p;
        return input.level === null ? rest : { ...rest, autonomy: input.level };
      }),
    };
  }
  const saved = checkConsent(next, input.confinement, input.acceptUnconfined);
  await saveGatewayConfig(home, saved);
  return saved;
}

export async function setChatBackend(
  home: string,
  input: { backend: "host" | "docker"; acceptUnconfined?: boolean; confinement: Confinement | null },
): Promise<GatewayConfig> {
  const config = await loadGatewayConfig(home);
  const saved = checkConsent({ ...config, chat: { ...config.chat, backend: input.backend } }, input.confinement, input.acceptUnconfined);
  await saveGatewayConfig(home, saved);
  return saved;
}

/** What a chat may do: move a project (or, for a built-in or unregistered one, the global level) to a stricter level. */
export async function lowerAutonomy(home: string, projectId: string, to: Autonomy): Promise<{ changed: boolean; level: Autonomy }> {
  const config = await loadGatewayConfig(home);
  const current = effectiveAutonomy(config, projectId);
  if (!canRaise(current, to)) throw new AutonomyError(RAISE_REFUSED);
  if (current === to) return { changed: false, level: current };
  const own = config.projects.some((p) => p.id === projectId);
  const next: GatewayConfig = own
    ? { ...config, projects: config.projects.map((p) => (p.id === projectId ? { ...p, autonomy: to } : p)) }
    : { ...config, chat: { ...config.chat, autonomy: to } };
  await saveGatewayConfig(home, next);
  return { changed: true, level: to };
}

export async function pinTestCommands(home: string, projectId: string, commands: string[]): Promise<GatewayConfig> {
  const config = await loadGatewayConfig(home);
  if (!config.projects.some((p) => p.id === projectId)) throw new AutonomyError(`No project "${projectId}" to pin test commands on.`);
  const next = { ...config, projects: config.projects.map((p) => (p.id === projectId ? { ...p, testCommands: commands } : p)) };
  await saveGatewayConfig(home, next);
  return next;
}

/** Writes `chat` the first time, as `loadGatewayConfig` decided, so a later approval can't change the decision. */
export async function ensureChatSettings(home: string): Promise<void> {
  let hasChat = false;
  try {
    const parsed = JSON.parse(await readFile(gatewayConfigPath(home), "utf8")) as unknown;
    hasChat = !!parsed && typeof parsed === "object" && "chat" in parsed;
  } catch {
    // missing or unreadable: loadGatewayConfig below decides (and reports a broken file)
  }
  if (hasChat) return;
  await saveGatewayConfig(home, await loadGatewayConfig(home));
}
