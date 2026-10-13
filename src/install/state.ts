// src/install/state.ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { InstallError, fromFsError } from "./errors";
import { writeFileAtomic } from "./files";
import type { Layout } from "./layout";
import { isVersion } from "./version";

export type SkipReason = "health-check" | "rolled-back";

export interface PendingSwitch {
  op: "switch";
  from: string | null;
  to: string;
}

export interface AutoUpdateState {
  lastCheck: string | null;
  failures: number;
  nextCheck: string | null;
  lastUpdated: string | null;
  announced: boolean;
}

export interface InstallState {
  schema: 1;
  generation: number;
  current: string | null;
  previous: string | null;
  pending: PendingSwitch | null;
  skip: Record<string, SkipReason>;
  autoUpdate: AutoUpdateState;
}

export function emptyState(): InstallState {
  return {
    schema: 1,
    generation: 0,
    current: null,
    previous: null,
    pending: null,
    skip: {},
    autoUpdate: { lastCheck: null, failures: 0, nextCheck: null, lastUpdated: null, announced: true },
  };
}

const version = z.string().refine(isVersion, "not a version");
const instant = z.iso.datetime().nullable();
const stateSchema = z
  .object({
    schema: z.literal(1),
    generation: z.number().int().min(0),
    current: version.nullable(),
    previous: version.nullable(),
    pending: z.object({ op: z.literal("switch"), from: version.nullable(), to: version }).strict().nullable(),
    skip: z.record(version, z.enum(["health-check", "rolled-back"])),
    autoUpdate: z
      .object({ lastCheck: instant, failures: z.number().int().min(0).max(64), nextCheck: instant, lastUpdated: version.nullable(), announced: z.boolean() })
      .strict(),
  })
  .strict();

export type ReadStateResult = { kind: "missing" } | { kind: "corrupt"; reason: string } | { kind: "ok"; state: InstallState };

export async function readState(l: Layout): Promise<ReadStateResult> {
  let text: string;
  try {
    text = await readFile(l.stateFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw fromFsError(e, `reading ${l.stateFile}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt", reason: "not JSON" };
  }
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return { kind: "corrupt", reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { kind: "ok", state: parsed.data as InstallState };
}

/** Writes atomically and returns the state as written (generation + 1). State is never trusted for integrity. */
export async function writeState(l: Layout, next: InstallState): Promise<InstallState> {
  const written: InstallState = { ...next, generation: next.generation + 1 };
  const check = stateSchema.safeParse(written);
  if (!check.success) {
    const issue = check.error.issues[0]!;
    throw new InstallError("local", `refusing to write an invalid install state: ${issue.path.join(".")}: ${issue.message}`);
  }
  await writeFileAtomic(l.stateFile, `${JSON.stringify(written, null, 2)}\n`, 0o600);
  return written;
}
