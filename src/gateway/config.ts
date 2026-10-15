// src/gateway/config.ts — ~/.tropos/gateway.json: the gateway's own settings, kept apart from settings.json.
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const sandboxSchema = z
  .object({
    image: z.string().min(1).default("alpine:3.22"),
    network: z.enum(["none", "bridge"]).default("none"),
    memory: z.string().min(1).default("1g"),
    cpus: z.string().min(1).default("2"),
  })
  .default({ image: "alpine:3.22", network: "none", memory: "1g", cpus: "2" });

const schema = z.object({
  /** The project directory the gateway's sessions work in: the only directory a channel session can touch. */
  workspace: z.string().min(1).optional(),
  telegram: z.object({ botToken: z.string().min(1).optional() }).default({}),
  sandbox: sandboxSchema,
  /** Minutes without a message before a chat's session (and its container) is closed. */
  idleMinutes: z.number().int().min(1).max(24 * 60).default(30),
  /** Port of the local web UI; unset picks the default and falls back to a free one. */
  webPort: z.number().int().min(1).max(65535).optional(),
});

export type GatewayConfig = z.infer<typeof schema>;

export class GatewayConfigError extends Error {}

export function gatewayDir(home: string): string {
  return join(home, "gateway");
}

export function gatewayConfigPath(home: string): string {
  return join(home, "gateway.json");
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
  const parsed = schema.safeParse(json);
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
