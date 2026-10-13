// src/providers/credentials.ts — API keys saved with /providers, in a file only the user can read.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const fileSchema = z.record(z.string(), z.object({ apiKey: z.string().min(1) }));
export type StoredCredentials = z.infer<typeof fileSchema>;

export class CredentialsError extends Error {}

export function credentialsPath(home: string): string {
  return join(home, "credentials.json");
}

export async function readCredentials(home: string): Promise<StoredCredentials> {
  const path = credentialsPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CredentialsError(`Could not read ${path}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CredentialsError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new CredentialsError(`${path} has an unexpected shape; fix or delete it`);
  return parsed.data;
}

/** Written to a private temp file and renamed into place, so the key is never readable by others. */
async function writeCredentials(home: string, creds: StoredCredentials): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = credentialsPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function saveApiKey(home: string, provider: string, apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new CredentialsError("The API key is empty.");
  if (/\s/.test(key)) throw new CredentialsError("The API key contains spaces or line breaks; paste just the key.");
  const creds = await readCredentials(home);
  creds[provider] = { apiKey: key };
  await writeCredentials(home, creds);
}

/** True when a saved key was removed. */
export async function removeApiKey(home: string, provider: string): Promise<boolean> {
  const creds = await readCredentials(home);
  if (!creds[provider]) return false;
  delete creds[provider];
  if (Object.keys(creds).length === 0) await rm(credentialsPath(home), { force: true });
  else await writeCredentials(home, creds);
  return true;
}

export type KeySource = { kind: "env"; name: string } | { kind: "saved" };

/** The provider's key: its environment variable wins over a saved key. */
export function resolveApiKey(
  envNames: readonly string[],
  provider: string,
  env: NodeJS.ProcessEnv,
  saved: StoredCredentials,
): { apiKey: string; source: KeySource } | null {
  for (const name of envNames) {
    const value = env[name]?.trim();
    if (value) return { apiKey: value, source: { kind: "env", name } };
  }
  const stored = saved[provider]?.apiKey;
  return stored ? { apiKey: stored, source: { kind: "saved" } } : null;
}
