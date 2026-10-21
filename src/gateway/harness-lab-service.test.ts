// src/gateway/harness-lab-service.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { LabTask } from "../harness/probe";
import type { LabTaskResult } from "../harness/service";
import { projectDir } from "../session/store";
import { createHarnessLabService, weeklySummary } from "./harness-lab-service";
import type { GatewayServiceDeps } from "./types";

let dir: string;
let home: string;
let repo: string;
beforeEach(async () => {
  dir = await makeTmpDir("weekly-lab-");
  home = join(dir, "home");
  repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "a.txt"), "a");
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "base"]]) Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  const sessions = projectDir(home, repo);
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, "11111111-1111-4111-8111-111111111111.jsonl"),
    [JSON.stringify({ type: "meta", cwd: repo, createdAt: "2026-10-20" }), JSON.stringify({ type: "message", ts: "", message: { role: "user", content: "Make the importer skip blank lines in CSV files" } })].join("\n"),
  );
});
afterEach(() => removeDir(dir));

const delivered: [string, string][] = [];
const deps = (): GatewayServiceDeps =>
  ({
    home,
    config: {} as GatewayServiceDeps["config"],
    projects: { list: async () => [{ id: "app", name: "app", path: repo }, { id: "default", name: "Default", path: join(dir, "nogit"), builtin: true }], get: async () => undefined, defaultId: async () => "default" },
    openSession: async () => {
      throw new Error("unused");
    },
    ownerChat: async () => "telegram:1",
    deliver: async (to: string, text: string) => void delivered.push([to, text]),
  }) as GatewayServiceDeps;

function result(task: LabTask, adopted: boolean): LabTaskResult {
  return {
    run: { id: "20261021-000000-aaaa", task, scope: "global", k: 1, mode: "parallel", model: "m", editorModel: "m", startedAt: "", probes: [], proposals: [], compositions: [], verdict: { outcome: "better", reasons: ["checks passed 0 → 1"] }, candidate: "20261021-000000-aaaa", costUsd: 0.5 },
    reflection: { lessons: [], dropped: [], stored: false, costUsd: 0 },
    ...(adopted ? { adopted: { id: "20261021-000000-aaaa" } as LabTaskResult["adopted"] } : { pending: "it adds scripts, which only the owner adopts" }),
  };
}

test("off by default; once on, it replays recent sessions of git projects at most once a week and tells the owner", async () => {
  delivered.length = 0;
  const ran: string[] = [];
  let now = new Date("2026-10-21T10:00:00Z");
  const service = createHarnessLabService({ command: ["tcode"], env: {}, now: () => now, runTask: async (task) => (ran.push(task.title), result(task, true)) });
  await service.tick(deps());
  expect(ran).toEqual([]); // settings.harness.lab is off

  await writeFile(join(home, "settings.json"), JSON.stringify({ harness: { lab: true } }));
  await service.tick(deps());
  expect(ran).toEqual(["Make the importer skip blank lines in CSV files"]);
  expect(delivered).toEqual([
    ["telegram:1", 'Harness lab: tested 1 task from last week\'s sessions ($0.50).\nAdopted a change that did better on "Make the importer skip blank lines in CSV files" (checks passed 0 → 1). Undo: tcode harness revert 20261021-000000-aaaa'],
  ]);

  now = new Date("2026-10-25T10:00:00Z");
  await service.tick(deps());
  expect(ran).toHaveLength(1); // not a week yet
  now = new Date("2026-10-29T10:00:00Z");
  await service.tick(deps());
  expect(ran).toHaveLength(2);
  await service.stop();
});

test("the summary says what waits for the owner, and when nothing changed", () => {
  const task = { title: "T" } as LabTask;
  expect(weeklySummary([])).toBeUndefined();
  expect(weeklySummary([result(task, false)])).toContain('A change for "T" waits for you (it adds scripts, which only the owner adopts): tcode harness diff 20261021-000000-aaaa');
  const none = { ...result(task, false), pending: undefined };
  none.run = { ...none.run, candidate: undefined };
  expect(weeklySummary([none])).toContain("Nothing did measurably better, so nothing changed.");
});
