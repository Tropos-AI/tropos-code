import type { ThemeSetting } from "../config/settings";

export interface Theme {
  name: "dark" | "light";
  accent: string;
  muted: string;
  text: string;
  success: string;
  danger: string;
  warning: string;
  diffAdd: string;
  diffRemove: string;
}

/** Tropos brand: periwinkle accent, warm stone neutrals. */
export const DARK: Theme = {
  name: "dark",
  accent: "#93B0FF",
  muted: "#A8A29E",
  text: "#F5F5F4",
  success: "#4ADE80",
  danger: "#F87171",
  warning: "#FBBF24",
  diffAdd: "#4ADE80",
  diffRemove: "#F87171",
};

export const LIGHT: Theme = {
  name: "light",
  accent: "#4568FF",
  muted: "#78716C",
  text: "#1C1917",
  success: "#15803D",
  danger: "#B91C1C",
  warning: "#B45309",
  diffAdd: "#15803D",
  diffRemove: "#B91C1C",
};

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
