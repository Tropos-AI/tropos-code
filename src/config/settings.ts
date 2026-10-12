// src/config/settings.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { projectKey } from "../paths";
import { DEFAULT_MODEL, EFFORTS, type Effort } from "./constants";

export type ThemeSetting = "auto" | "dark" | "light";

export interface PermissionRulesConfig {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface Settings {
  model: string;
  effort: Effort;
  theme: ThemeSetting;
  permissions: PermissionRulesConfig;
  additionalDirectories: string[];
  refusalFallback: boolean;
  env: Record<string, string>;
}

export type PartialSettings = Partial<Omit<Settings, "permissions">> & {
  permissions?: Partial<PermissionRulesConfig>;
};

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  effort: "high",
  theme: "auto",
  permissions: { allow: [], ask: [], deny: [] },
  additionalDirectories: [],
  refusalFallback: true,
  env: {},
};

export interface SettingsPaths {
  user: string;
  userProject: string;
  project: string;
  local: string;
}

export function settingsPaths(cwd: string, home: string): SettingsPaths {
  return {
    user: join(home, "settings.json"),
    userProject: join(home, "projects", projectKey(cwd), "settings.json"),
    project: join(cwd, ".tropos", "settings.json"),
    local: join(cwd, ".tropos", "settings.local.json"),
  };
}

export class SettingsError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Invalid settings file ${path}: ${detail}`);
  }
}

const layerSchema = z.object({
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
  theme: z.enum(["auto", "dark", "light"]).optional(),
  permissions: z
    .object({
      allow: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  additionalDirectories: z.array(z.string()).optional(),
  refusalFallback: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

function union(a: string[], b: string[] = []): string[] {
  return [...new Set([...a, ...b])];
}

export function mergeSettings(base: Settings, layer: PartialSettings): Settings {
  return {
    model: layer.model ?? base.model,
    effort: layer.effort ?? base.effort,
    theme: layer.theme ?? base.theme,
    permissions: {
      allow: union(base.permissions.allow, layer.permissions?.allow),
      ask: union(base.permissions.ask, layer.permissions?.ask),
      deny: union(base.permissions.deny, layer.permissions?.deny),
    },
    additionalDirectories: union(base.additionalDirectories, layer.additionalDirectories),
    refusalFallback: layer.refusalFallback ?? base.refusalFallback,
    env: { ...base.env, ...layer.env },
  };
}

async function readJson(path: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SettingsError(path, (err as Error).message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SettingsError(path, (err as Error).message);
  }
}

export async function readSettingsFile(path: string): Promise<PartialSettings | null> {
  const raw = await readJson(path);
  if (raw === null) return null;
  const parsed = layerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsError(path, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

const REPO_RESTRICTION_HINT =
  "repo settings may only set model, effort, theme, refusalFallback and ask/deny rules; put the rest in ~/.tropos";

/**
 * Repo-shipped files arrive with the code, so they cannot grant allow rules, env or extra
 * directories. Keeps only the keys they may set and reports anything dropped.
 */
function restrictRepoLayer(path: string, layer: PartialSettings): { layer: PartialSettings; warning?: string } {
  const ignored: string[] = [];
  if (layer.permissions?.allow?.length) ignored.push("permissions.allow");
  if (layer.env && Object.keys(layer.env).length > 0) ignored.push("env");
  if (layer.additionalDirectories?.length) ignored.push("additionalDirectories");
  const restricted: PartialSettings = {
    model: layer.model,
    effort: layer.effort,
    theme: layer.theme,
    refusalFallback: layer.refusalFallback,
    permissions: { ask: layer.permissions?.ask, deny: layer.permissions?.deny },
  };
  if (ignored.length === 0) return { layer: restricted };
  return { layer: restricted, warning: `${path}: ignored ${ignored.join(", ")} (${REPO_RESTRICTION_HINT})` };
}

export interface LoadedSettings {
  settings: Settings;
  /** Notices for the user, such as repo-shipped keys that were ignored. */
  warnings: string[];
}

/** Merge order: user, userProject, project, local, then CLI overrides (trusted). */
export async function loadSettings(paths: SettingsPaths, overrides: PartialSettings = {}): Promise<LoadedSettings> {
  let settings = DEFAULT_SETTINGS;
  const warnings: string[] = [];
  const layers: Array<[path: string, trusted: boolean]> = [
    [paths.user, true],
    [paths.userProject, true],
    [paths.project, false],
    [paths.local, false],
  ];
  for (const [path, trusted] of layers) {
    const parsed = await readSettingsFile(path);
    if (!parsed) continue;
    const { layer, warning } = trusted ? { layer: parsed, warning: undefined } : restrictRepoLayer(path, parsed);
    if (warning) warnings.push(warning);
    settings = mergeSettings(settings, layer);
  }
  return { settings: mergeSettings(settings, overrides), warnings };
}

/** Adds an allow rule to the project-local settings file, keeping every other key as-is. */
export async function addLocalAllowRule(localPath: string, rule: string): Promise<void> {
  const raw = ((await readJson(localPath)) ?? {}) as Record<string, unknown>;
  const permissions = (raw.permissions ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  if (!allow.includes(rule)) allow.push(rule);
  const next = { ...raw, permissions: { ...permissions, allow } };
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, `${JSON.stringify(next, null, 2)}\n`);
}
