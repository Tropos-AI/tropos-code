import type { ThemeSetting } from "../config/settings";

export interface Theme {
  name: "dark" | "light";
  /** Brand periwinkle: spinner, selection, dialog titles, prompt glyph. */
  accent: string;
  /** Lighter brand tone for the spinner's shimmer band. */
  shimmer: string;
  muted: string;
  /** Quieter than muted: user-prompt glyphs, rejected tool results. */
  subtle: string;
  text: string;
  success: string;
  danger: string;
  warning: string;
  /** Diff text colors (used where no background is drawn) and full-line backgrounds. */
  diffAdd: string;
  diffRemove: string;
  diffAddBg: string;
  diffRemoveBg: string;
  /** Background behind the user's own messages. */
  userBg: string;
  /** Rules above and below the prompt input. */
  promptBorder: string;
  /** Permission-mode indicators. */
  acceptEdits: string;
  planMode: string;
  /** Slash-suggestion colors by kind: built-in commands, custom commands, skills. */
  command: string;
  customCommand: string;
  skill: string;
  /** Background colors for subagent type badges, cycled by name. */
  agentColors: string[];
}

const AGENT_COLORS = ["#2563EB", "#16A34A", "#9333EA", "#EA580C", "#DB2777", "#0891B2", "#CA8A04", "#DC2626"];

/** Tropos brand: periwinkle accent, warm stone neutrals. */
export const DARK: Theme = {
  name: "dark",
  accent: "#93B0FF",
  shimmer: "#C7D5FF",
  muted: "#A8A29E",
  subtle: "#6B6560",
  text: "#F5F5F4",
  success: "#4ADE80",
  danger: "#F87171",
  warning: "#FBBF24",
  diffAdd: "#4ADE80",
  diffRemove: "#F87171",
  diffAddBg: "#1F4D2A",
  diffRemoveBg: "#5C2430",
  userBg: "#373737",
  promptBorder: "#888888",
  acceptEdits: "#AF87FF",
  planMode: "#48968C",
  command: "#93B0FF",
  customCommand: "#5EEAD4",
  skill: "#F0ABFC",
  agentColors: AGENT_COLORS,
};

export const LIGHT: Theme = {
  name: "light",
  accent: "#4568FF",
  shimmer: "#8FA6FF",
  muted: "#78716C",
  subtle: "#A8A29E",
  text: "#1C1917",
  success: "#15803D",
  danger: "#B91C1C",
  warning: "#B45309",
  diffAdd: "#15803D",
  diffRemove: "#B91C1C",
  diffAddBg: "#C6F6D0",
  diffRemoveBg: "#FFD3DA",
  userBg: "#F0F0F0",
  promptBorder: "#999999",
  acceptEdits: "#8700FF",
  planMode: "#006666",
  command: "#4568FF",
  customCommand: "#0F766E",
  skill: "#A21CAF",
  agentColors: AGENT_COLORS,
};

/** A stable badge color for a subagent type, so the same agent always looks the same. */
export function agentColor(theme: Theme, name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return theme.agentColors[hash % theme.agentColors.length]!;
}

/** COLORFGBG is "fg;bg" (sometimes "fg;x;bg"); background 7 or 15 means a light terminal. */
function lightBackground(env: NodeJS.ProcessEnv): boolean | undefined {
  const value = env.COLORFGBG;
  if (!value) return undefined;
  const bg = Number(value.split(";").at(-1));
  if (Number.isNaN(bg)) return undefined;
  return bg === 7 || bg === 15;
}

export function resolveTheme(setting: ThemeSetting, env: NodeJS.ProcessEnv = process.env): Theme {
  if (setting === "dark") return DARK;
  if (setting === "light") return LIGHT;
  return lightBackground(env) ? LIGHT : DARK;
}
