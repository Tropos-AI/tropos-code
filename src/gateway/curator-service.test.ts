import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { renderSpecialistFile } from "../agents/specialists";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { LEARNED_SKILLS_DIR } from "../extensions/sources";
import { Ledger } from "../learning/ledger";
import { createCuratorService } from "./curator-service";
import type { GatewayServiceDeps } from "./types";

let home: string;
const T0 = new Date("2026-10-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(async () => {
  await removeDir(home);
});

const deps = () => ({ home }) as unknown as GatewayServiceDeps;

async function staleSkill(name: string) {
  const file = join(home, LEARNED_SKILLS_DIR, name, "SKILL.md");
  const text = `---\ndescription: ${name}\n---\nbody\n`;
  await mkdir(join(home, LEARNED_SKILLS_DIR, name), { recursive: true });
  await writeFile(file, text);
  const ledger = new Ledger(home, { now: () => new Date(T0.getTime() - 60 * DAY) });
  await ledger.record({ actor: "agent", kind: "skill", path: file, action: "create", summary: `create ${name}`, before: null, after: text });
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
}

test("runs at start and on every tick, logs what it archived, and stops cleanly", async () => {
  await staleSkill("a");
  const logs: string[] = [];
  let calls = 0;
  // Each look at the clock is a week later than the last, so every run is due.
  const now = () => new Date(T0.getTime() + calls++ * 8 * DAY);
  const service = createCuratorService({ everyMs: 10, now, log: (m) => logs.push(m) });
  expect(service.name).toBe("curator");
  await service.start(deps());
  await until(() => logs.includes("archived 1 learned skill(s): a"));

  await staleSkill("b");
  await until(() => logs.includes("archived 1 learned skill(s): b"));

  await service.stop();
  const after = calls;
  await Bun.sleep(60);
  expect(calls).toBe(after);
});

test("a failing run is logged and the next tick tries again", async () => {
  // A file where the home directory should be makes every run fail.
  const file = join(home, "not-a-dir");
  await writeFile(file, "x");
  const logs: string[] = [];
  const service = createCuratorService({ everyMs: 10, now: () => T0, log: (m) => logs.push(m) });
  await service.start({ home: file } as unknown as GatewayServiceDeps);
  await until(() => logs.length >= 2);
  await service.stop();
  expect(logs.every((l) => l.startsWith("failed: "))).toBe(true);
});

test("logs the specialists it archived next to the skills line", async () => {
  const dir = join(home, "agents", "idle");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "AGENT.md"), renderSpecialistFile({ name: "idle", description: "d", prompt: "## Purpose\nx", createdBy: "user", createdAt: T0.getTime() - 90 * DAY, revision: 1 }));
  await utimes(join(dir, "AGENT.md"), new Date(T0.getTime() - 90 * DAY), new Date(T0.getTime() - 90 * DAY));
  const logs: string[] = [];
  const service = createCuratorService({ everyMs: 100_000, now: () => T0, log: (m) => logs.push(m) });
  await service.start(deps());
  await until(() => logs.includes("archived 1 specialist(s): idle"));
  await service.stop();
});
