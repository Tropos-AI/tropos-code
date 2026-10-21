// src/harness/surface.ts — which files a harness tree may hold, and the budget its always-on files share (Harness²'s
// SurfaceSpec). A file off this surface is never loaded; permissions, the sandbox and autonomy are not on it at all.

/** Loaded into every session's system prompt, in this order. */
export const ALWAYS_ON = ["system.md", "guardrails.md", "tool-guidance.md"] as const;

/** Characters the always-on files may hold together: every rule an editor adds has to fit, so adding means cutting. */
export const ALWAYS_ON_CHARS = 24_000;

/** Largest file a harness layer may hold. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Files read from one layer before the rest is ignored. */
export const MAX_FILES = 200;

export type SurfaceKind = "always-on" | "skill" | "script" | "agent" | "hooks";

const NAME = "[a-z0-9]+(?:-[a-z0-9]+)*";
const SURFACE: [SurfaceKind, RegExp][] = [
  ["always-on", /^(?:system|guardrails|tool-guidance)\.md$/],
  ["skill", new RegExp(`^skills/${NAME}/SKILL\\.md$`)],
  ["script", new RegExp(`^scripts/${NAME}(?:\\.[a-z0-9]+)?$`)],
  ["agent", new RegExp(`^agents/${NAME}\\.md$`)],
  ["hooks", /^hooks\.json$/],
];

/** What a path inside a harness tree is, or null when it is off the surface. Paths use "/" and are relative. */
export function surfaceKind(path: string): SurfaceKind | null {
  for (const [kind, pattern] of SURFACE) if (pattern.test(path)) return kind;
  return null;
}

/** Kinds that run code: adopting a change to them always needs the owner. */
export function runsCode(kind: SurfaceKind): boolean {
  return kind === "script" || kind === "hooks";
}
