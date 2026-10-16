// src/gateway/config.ts — ~/.tropos/gateway.json: the gateway's own settings, kept apart from settings.json.
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const sandboxSchema = z
  .object({
    image: z.string().min(1).default("alpine:3.22"),
    network: z.enum(["none", "bridge"]).default("none"),
    memory: z.string().min(1).default("1g"),
    cpus: z.string().min(1).default("2"),
  })
  .default({ image: "alpine:3.22", network: "none", memory: "1g", cpus: "2" });

/** Ids the gateway gives out itself: the managed default project and a one-off `--workspace`. */
export const RESERVED_PROJECT_IDS = ["default", "cwd"] as const;

const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "project ids are lowercase letters, digits and dashes"),
  name: z.string().min(1).max(80),
  path: z.string().min(1),
});
export type ProjectEntry = z.infer<typeof projectSchema>;

/** `My Project!` -> `my-project`: the id a project gets from its name. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "project";
}

/** A slug that is not in `taken` (and not reserved): `app`, `app-2`, `app-3` … */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const used = new Set<string>([...taken, ...RESERVED_PROJECT_IDS]);
  const base = slugify(name);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 40 - String(n).length - 1)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

const schema = z.object({
  /** The projects chats can work in besides the built-in `default`; each is the only directory its sessions can touch. */
  projects: z.array(projectSchema).default([]),
  /** The project a chat starts in until it picks another. */
  defaultProject: z.string().min(1).default("default"),
  telegram: z.object({ botToken: z.string().min(1).optional() }).default({}),
  sandbox: sandboxSchema,
  /** Minutes without a message before a chat's session (and its container) is closed. */
  idleMinutes: z.number().int().min(1).max(24 * 60).default(30),
  /** Port of the local web UI; unset picks the default and falls back to a free one. */
  webPort: z.number().int().min(1).max(65535).optional(),
});

/** The file's schema, for the config store and the web editor. */
export const gatewayConfigSchema = schema;

export type GatewayConfig = z.infer<typeof schema>;

export class GatewayConfigError extends Error {}

export function gatewayDir(home: string): string {
  return join(home, "gateway");
}

export function gatewayLogPath(home: string): string {
  return join(gatewayDir(home), "gateway.log");
}

export function gatewayConfigPath(home: string): string {
  return join(home, "gateway.json");
}

/**
 * Files from before projects had a `workspace` key. It becomes a project named after its directory (and the default,
 * unless the file already chose one), so the same gateway keeps working in the same place. The key is gone on next save.
 */
function migrateLegacy(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const { workspace, ...rest } = json as Record<string, unknown>;
  if (typeof workspace !== "string" || workspace === "") return rest;
  const projects = Array.isArray(rest.projects) ? [...(rest.projects as unknown[])] : [];
  const known = projects.find((p) => (p as { path?: unknown } | null)?.path === workspace) as { id?: string } | undefined;
  let id = known?.id;
  if (!id) {
    id = uniqueSlug(basename(workspace), projects.map((p) => (p as { id?: string } | null)?.id).filter((x): x is string => typeof x === "string"));
    projects.push({ id, name: basename(workspace) || id, path: workspace });
  }
  return { ...rest, projects, defaultProject: rest.defaultProject ?? id };
}

/** Reads the file; a missing one is the defaults, an unreadable or invalid one is an error naming the file. */
export async function loadGatewayConfig(home: string): Promise<GatewayConfig> {
  const path = gatewayConfigPath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return schema.parse({});
    throw new GatewayConfigError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new GatewayConfigError(`${path} is not valid JSON.`);
  }
  const parsed = schema.safeParse(migrateLegacy(json));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new GatewayConfigError(`Invalid ${path}: ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "unknown problem"}`);
  }
  return parsed.data;
}

/** Writes the file privately (0600): it can hold the bot token. */
export async function saveGatewayConfig(home: string, config: GatewayConfig): Promise<void> {
  const path = gatewayConfigPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(schema.parse(config), null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** The bot token: the environment wins over the file. */
export function telegramToken(config: GatewayConfig, env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.TROPOS_TELEGRAM_BOT_TOKEN?.trim();
  return fromEnv ? fromEnv : config.telegram.botToken;
}

/** A warning when the file that may hold the token is readable by other users; undefined when fine or absent. */
export async function configPermissionWarning(home: string): Promise<string | undefined> {
  const path = gatewayConfigPath(home);
  const info = await stat(path).catch(() => null);
  if (!info || process.platform === "win32") return undefined;
  return (info.mode & 0o077) !== 0 ? `${path} is readable by other users; run: chmod 600 ${path}` : undefined;
}
