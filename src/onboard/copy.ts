// src/onboard/copy.ts — the words setup shows, shared by the terminal wizard and the web page. No Node imports, so
// the web app can import it as `@core/onboard/copy`.
import type { AutonomyLevel, OnboardStepId } from "../web/admin/api";

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

/** One sentence on what each step is for; the terminal and the web page show it under the step's title. */
export const STEP_WHY: Record<OnboardStepId, string> = {
  welcome: "This takes about 3 minutes; every step after the model can be skipped and done later.",
  provider: "Tropos needs an AI provider to think with.",
  model: "This is the model that answers; the provider's best one is picked for you.",
  identity: "Give your agent a name and a personality, so it feels like yours.",
  projects: "Projects are the folders Tropos may work in when you message it.",
  autonomy: "Choose how much chats may do without asking you first.",
  telegram: "Talk to Tropos from your phone through your own Telegram bot.",
  phone: "Open this dashboard from your phone, privately, through Tailscale.",
  service: "Keep Tropos running in the background, so chats and schedules work when this terminal is closed.",
  done: "A quick health check, then a summary of what is ready.",
};
