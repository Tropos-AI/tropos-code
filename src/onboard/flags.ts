// src/onboard/flags.ts — whether the owner has finished or dismissed the setup wizard. One small file, shared by
// the wizard, `tcode status` and the web status call, so they agree on when to stop suggesting setup.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface OnboardingFlags {
  /** ISO time the owner finished or dismissed the wizard. */
  dismissedAt?: string;
  /** Steps the owner chose to skip (shown as "skipped", not as todo). */
  skipped?: string[];
  /** The owner picked the autonomy level in setup or in Settings (the stored `chat` key can't tell: it is written at start-up). */
  autonomyChosen?: boolean;
  /** ISO time setup was first opened (the welcome step is done from then on). */
  startedAt?: string;
  /** Steps whose "set this up later" reminder was already shown. */
  reminded?: string[];
}

export const onboardingFlagsPath = (home: string) => join(home, "onboarding.json");

export async function readOnboardingFlags(home: string): Promise<OnboardingFlags> {
  try {
    const json = JSON.parse(await readFile(onboardingFlagsPath(home), "utf8")) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) return {};
    const o = json as Record<string, unknown>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
    return {
      dismissedAt: typeof o.dismissedAt === "string" ? o.dismissedAt : undefined,
      skipped: strings(o.skipped),
      ...(o.autonomyChosen === true ? { autonomyChosen: true } : {}),
      ...(typeof o.startedAt === "string" ? { startedAt: o.startedAt } : {}),
      ...(Array.isArray(o.reminded) ? { reminded: strings(o.reminded) } : {}),
    };
  } catch {
    return {};
  }
}

export async function writeOnboardingFlags(home: string, flags: OnboardingFlags): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = onboardingFlagsPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(flags, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Merges `patch` into the stored flags. */
export async function updateOnboardingFlags(home: string, patch: OnboardingFlags): Promise<OnboardingFlags> {
  const merged = { ...(await readOnboardingFlags(home)), ...patch };
  await writeOnboardingFlags(home, merged);
  return merged;
}
