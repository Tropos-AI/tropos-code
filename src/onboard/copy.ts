// src/onboard/copy.ts — the words setup shows, shared by the terminal wizard and the web page. No Node imports, so
// the web app can import it as `@core/onboard/copy`.
import type { AutonomyLevel } from "../web/admin/api";

export interface IdentitySuggestion {
  name: string;
  emoji: string;
  vibe: string;
}

/** Starting points for "who should I be?"; every one passes the same checks as a typed answer. */
export const IDENTITY_SUGGESTIONS: readonly IdentitySuggestion[] = [
  { name: "Tropos", emoji: "🧭", vibe: "calm, direct, gets things done" },
  { name: "Atlas", emoji: "🗺️", vibe: "patient, thorough, explains as it goes" },
  { name: "Nova", emoji: "✨", vibe: "quick, upbeat, likes to try things" },
];

export const AUTONOMY_CHOICES: readonly { level: AutonomyLevel; label: string; risk: string }[] = [
  { level: "ask", label: "Ask", risk: "Asks before every edit and command. Safest, and the slowest from your phone." },
  { level: "balanced", label: "Balanced", risk: "Edits files and runs read-only commands and your tests without asking; asks before anything else." },
  { level: "autonomous", label: "Autonomous", risk: "Runs any command in the project without asking, still inside the sandbox; only MCP tools ask." },
];

export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
