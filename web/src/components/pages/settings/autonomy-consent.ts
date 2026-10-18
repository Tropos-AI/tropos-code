// web/src/components/pages/settings/autonomy-consent.ts — mirrors the server's "run unconfined" rule
// (src/gateway/autonomy.ts needsUnconfinedConsent) so the page can ask before it sends, instead of showing a refusal.
// The server stays the authority: if this and the server disagree, the server's message is shown.
import type { AutonomyLevel, AutonomyView } from "@core/web/admin/api";

export const UNCONFINED_TITLE = "Commands would run without the OS sandbox";
export const UNCONFINED_TEXT =
  "Commands can't be confined on this computer (no sandbox-exec or bwrap), so at this setting chat commands would run as you, with nothing limiting them. Run unconfined only if you accept that.";

export interface PendingChange {
  backend?: "host" | "docker";
  /** The global level. */
  level?: AutonomyLevel;
  /** One project's level; null makes it follow the global one. */
  project?: { id: string; level: AutonomyLevel | null };
}

/** True when applying `change` to `view` needs the owner's consent to run unconfined (and none is recorded yet). */
export function needsConsent(view: AutonomyView, change: PendingChange): boolean {
  const backend = change.backend ?? view.backend;
  if (backend !== "host" || view.confinement !== null || view.unconfinedAccepted) return false;
  const global = change.level ?? view.level;
  const projectLevels = view.projects.map((p) => (change.project?.id === p.id ? (change.project.level ?? undefined) : p.level));
  return global !== "ask" || projectLevels.some((l) => l !== undefined && l !== "ask");
}
