// src/tools/setup/autonomy.ts — the setup tool's only way to touch autonomy: lowering it, built on P2's lowerAutonomy.
import { AutonomyError, effectiveAutonomy, lowerAutonomy, RAISE_REFUSED, UNCONFINED_CONSENT } from "../../gateway/autonomy";
import { loadGatewayConfig, type Autonomy, type GatewayConfig } from "../../gateway/config";
import { dashboardLink } from "../../gateway/dashboard-link";
import { DEFAULT_PROJECT_ID, TEMPORARY_PROJECT_ID } from "../../gateway/projects";
import { SetupRefused } from "./matrix";

const RANK: Record<Autonomy, number> = { ask: 0, balanced: 1, autonomous: 2 };

/** What a refused raise says: where the owner raises it instead. */
export function raiseRefusal(config: Pick<GatewayConfig, "webPort">): string {
  return `I can't raise autonomy from here. Open ${dashboardLink(config, "settings/autonomy")} to change it (Settings → Autonomy).`;
}

/** An autonomy refusal as the owner should hear it: a raise, a missing consent to run unconfined, or as it was said. */
export function autonomyRefusal(e: AutonomyError, config: Pick<GatewayConfig, "webPort">): SetupRefused {
  if (e.message === RAISE_REFUSED) return new SetupRefused(raiseRefusal(config));
  if (e.message === UNCONFINED_CONSENT) {
    return new SetupRefused(
      `Commands can't be confined on this machine, so that level would let chat commands run unconfined as you, and that needs your consent at the computer. Open ${dashboardLink(config, "settings/autonomy")} (Settings → Autonomy).`,
    );
  }
  return new SetupRefused(e.message);
}

/**
 * Lowers one project's level, or, without a project, the global level and every project override above `to`, so
 * "be more careful" applies everywhere. A raise is refused before anything is written.
 */
export async function lowerSetupAutonomy(home: string, to: Autonomy, projectId?: string): Promise<{ before: Autonomy; after: Autonomy }> {
  const config = await loadGatewayConfig(home);
  try {
    if (projectId !== undefined) {
      const builtIn = projectId === DEFAULT_PROJECT_ID || projectId === TEMPORARY_PROJECT_ID;
      // P2's lowerAutonomy treats an unknown id as the global level; here a typo must not lower everything.
      if (!builtIn && !config.projects.some((p) => p.id === projectId)) throw new SetupRefused(`There is no project "${projectId}".`);
      const before = effectiveAutonomy(config, projectId);
      const out = await lowerAutonomy(home, projectId, to);
      return { before, after: out.level };
    }
    const before = config.chat.autonomy;
    const out = await lowerAutonomy(home, DEFAULT_PROJECT_ID, to);
    for (const p of config.projects) {
      if (p.autonomy !== undefined && RANK[p.autonomy] > RANK[to]) await lowerAutonomy(home, p.id, to);
    }
    return { before, after: out.level };
  } catch (e) {
    if (e instanceof AutonomyError) throw autonomyRefusal(e, config);
    throw e;
  }
}
