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

export const BOTFATHER_URL = "https://t.me/BotFather";
export const BOTFATHER_STEPS: readonly string[] = [
  "In Telegram, open @BotFather and send /newbot.",
  "Pick a name, then a username that ends in “bot”.",
  "BotFather answers with a token like 123456:ABC-DEF…; copy it and paste it here.",
];

/** Three things worth asking first; the first names the user's own project when there is one. */
export function exampleAsks(project?: string): string[] {
  return [
    project ? `What changed in ${project} this week?` : "What changed in my project this week?",
    "Every weekday at 9, summarise my open pull requests.",
    "Remember that I deploy on Fridays.",
  ];
}

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

export const WELCOME_LINES: readonly string[] = [
  "Welcome to Tropos. I'll set everything up with you, one short step at a time.",
  STEP_WHY.welcome,
  "Enter accepts what I suggest, s skips a step, b goes back. You can stop any time and run `tcode onboard` again to continue.",
];

export const RISK_NOTICE: readonly string[] = [
  "Tropos reads and edits files and runs commands in the folders you point it at; it asks before anything risky.",
  "Your provider key is stored only on this machine, in ~/.tropos/credentials.json (mode 0600), and sent only to that provider.",
  "Chats from Telegram run commands on this computer inside its own sandbox, only in the project you picked; the autonomy level you choose decides what they may do without asking.",
  "You can review or undo all of this later with `tcode status`, `tcode doctor` and `tcode uninstall`.",
];
