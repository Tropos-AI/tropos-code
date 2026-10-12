// src/config/settings.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
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
  project: string;
  local: string;
}

export function settingsPaths(cwd: string, home: string): SettingsPaths {
  return {
    user: join(home, "settings.json"),
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

export async function loadSettings(paths: SettingsPaths, overrides: PartialSettings = {}): Promise<Settings> {
  let settings = DEFAULT_SETTINGS;
  for (const path of [paths.user, paths.project, paths.local]) {
    const layer = await readSettingsFile(path);
    if (layer) settings = mergeSettings(settings, layer);
  }
  return mergeSettings(settings, overrides);
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
