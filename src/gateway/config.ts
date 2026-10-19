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

/** How freely a chat's agent may act without asking: never, inside the confined project, or everywhere it can reach. */
export const AUTONOMY_LEVELS = ["ask", "balanced", "autonomous"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "project ids are lowercase letters, digits and dashes"),
  name: z.string().min(1).max(80),
  path: z.string().min(1),
  /** Overrides `chat.autonomy` for chats working in this project. */
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
  /** Guests may see and enter this project. Off unless the owner shares it (`tcode projects share`). */
  shared: z.boolean().optional(),
  /** Test commands the owner confirmed; the agent may run these unasked at `balanced`. */
  testCommands: z.array(z.string().min(1)).max(10).optional(),
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

/** C8's proactive-message defaults: quiet outside 09:00-21:00, at most one note a day, checked every 4 hours. */
export const PROACTIVE_DEFAULTS = { activeHours: { start: "09:00", end: "21:00" }, everyHours: 4, maxPerDay: 1 } as const;

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 09:00");

const schema = z.object({
  /** The projects chats can work in besides the built-in `default`; each is the only directory its sessions can touch. */
  projects: z.array(projectSchema).default([]),
  /** The project a chat starts in until it picks another. */
  defaultProject: z.string().min(1).default("default"),
  telegram: z.object({ botToken: z.string().min(1).optional() }).default({}),
  sandbox: sandboxSchema,
  /** How chats run commands and how freely they act. */
  chat: z
    .object({
      autonomy: z.enum(AUTONOMY_LEVELS).default("balanced"),
      backend: z.enum(["host", "docker"]).default("host"),
      /** The owner accepted that, with no sandbox-exec or bwrap, chat commands run unconfined as them. */
      allowUnconfined: z.boolean().optional(),
    })
    .default({ autonomy: "balanced", backend: "host" }),
  /** Minutes without a message before a chat's session (and its container) is closed. */
  idleMinutes: z.number().int().min(1).max(24 * 60).default(30),
  /** Port of the dashboard; unset is 4317. Never changes by itself. */
  webPort: z.number().int().min(1).max(65535).optional(),
  /** Messages the agent starts itself. `enabled` unset follows whether Telegram is connected. */
  proactive: z
    .object({
      enabled: z.boolean().optional(),
      activeHours: z.object({ start: timeOfDay, end: timeOfDay }).default({ ...PROACTIVE_DEFAULTS.activeHours }),
      everyHours: z.number().int().min(1).max(24).default(PROACTIVE_DEFAULTS.everyHours),
      maxPerDay: z.number().int().min(0).max(3).default(PROACTIVE_DEFAULTS.maxPerDay),
    })
    .default({ ...PROACTIVE_DEFAULTS, activeHours: { ...PROACTIVE_DEFAULTS.activeHours } }),
  /** Where new projects are created; unset is ~/Projects. */
  newProjectsDir: z.string().min(1).optional(),
  /** Real paths of projects the owner removed, so running `tcode` there doesn't add them back. */
  removedProjectPaths: z.array(z.string().min(1)).default([]),
  /** Phone access: the dashboard published to the owner's own tailnet by `tailscale serve` (never Funnel). */
  remoteAccess: z
    .object({
      tailscale: z.boolean().default(false),
      /** The HTTPS port `tailscale serve` uses on the tailnet name (443, 8443 or 10000). */
      httpsPort: z.number().int().min(1).max(65535).optional(),
      /** The tailnet name, e.g. mac.tail1234.ts.net. It becomes an accepted Host, so only a *.ts.net name is allowed. */
      hostname: z
        .string()
        .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$/i, "must be a *.ts.net name")
        .optional(),
      /** Turning it off couldn't reach Tailscale, so the serve config may still exist: retried at gateway start and by doctor. */
      pendingDisable: z.boolean().optional(),
    })
    .default({ tailscale: false }),
});

/** The file's schema, for the config store and the web editor. */
export const gatewayConfigSchema = schema;

export type GatewayConfig = z.infer<typeof schema>;
export type ProactiveConfig = GatewayConfig["proactive"];

/** Proactive messages are on when the owner said so, else when there is a Telegram chat to send them to. */
export function proactiveEnabled(config: GatewayConfig, telegramConnected: boolean): boolean {
  return config.proactive.enabled ?? telegramConnected;
}

/** Where new projects are created; `~/` expands against `userHome`. */
export function newProjectsDirOf(config: GatewayConfig, userHome: string): string {
  const dir = config.newProjectsDir;
  if (!dir) return join(userHome, "Projects");
  if (dir === "~") return userHome;
  return dir.startsWith("~/") ? join(userHome, dir.slice(2)) : dir;
}

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

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Whether this home was in use before chats got autonomy settings: someone is approved, setup was finished or
 * dismissed, a scheduled job exists, or a bot token was saved. Such an install keeps `ask` + `docker` until the
 * owner changes it. A gateway.json holding only projects (the wizard's projects step) does not count.
 */
export async function existingInstall(home: string): Promise<boolean> {
  const pairing = (await readJson(join(gatewayDir(home), "pairing.json"))) as { approved?: unknown } | undefined;
  if (Array.isArray(pairing?.approved) && pairing.approved.length > 0) return true;
  const onboarding = (await readJson(join(home, "onboarding.json"))) as { dismissedAt?: unknown } | undefined;
  if (onboarding?.dismissedAt) return true;
  const jobs = (await readJson(join(gatewayDir(home), "cron", "jobs.json"))) as { jobs?: unknown } | undefined;
  if (Array.isArray(jobs?.jobs) && jobs.jobs.length > 0) return true;
  const gateway = (await readJson(gatewayConfigPath(home))) as { telegram?: { botToken?: unknown } } | undefined;
  return typeof gateway?.telegram?.botToken === "string" && gateway.telegram.botToken !== "";
}

const EXISTING_INSTALL_CHAT = { autonomy: "ask", backend: "docker" } as const;

/** Reads the file; a missing one is the defaults, an unreadable or invalid one is an error naming the file. */
export async function loadGatewayConfig(home: string): Promise<GatewayConfig> {
  const path = gatewayConfigPath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return schema.parse((await existingInstall(home)) ? { chat: EXISTING_INSTALL_CHAT } : {});
    throw new GatewayConfigError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new GatewayConfigError(`${path} is not valid JSON.`);
  }
  let migrated = migrateLegacy(json);
  // No chat key yet: an install that predates the setting keeps its old rules (docker, ask) until the owner changes them.
  if (migrated && typeof migrated === "object" && !Array.isArray(migrated) && !("chat" in migrated) && (await existingInstall(home))) {
    migrated = { ...migrated, chat: EXISTING_INSTALL_CHAT };
  }
  const parsed = schema.safeParse(migrated);
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
