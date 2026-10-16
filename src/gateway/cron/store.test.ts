import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { CronStore } from "./store";
import type { RunRecord } from "./types";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

const base = { name: "n", schedule: { kind: "every" as const, ms: 60_000 }, prompt: "p" };
const mode = (p: string) => statSync(p).mode & 0o777;
const run = (jobId: string, n: number, summary = "ok"): RunRecord => ({ jobId, runId: `r${n}`, startedAt: n, endedAt: n + 1, status: "ok", summary });

test("add applies defaults and writes a versioned 0600 file", () => {
  const store = new CronStore(home, { now: () => 42 });
  const job = store.add(base);
  expect(job).toMatchObject({ project: "default", deliver: "none", enabled: true, createdBy: "user", createdAt: 42 });
  expect(job.id).toMatch(/^[0-9a-f]{8}$/);
  expect(mode(store.jobsPath)).toBe(0o600);
  expect(JSON.parse(readFileSync(store.jobsPath, "utf8"))).toMatchObject({ version: 1, jobs: [{ id: job.id }] });
  expect(readdirSync(store.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("get, update, setEnabled, remove", () => {
  const store = new CronStore(home);
  const a = store.add(base);
  const b = store.add({ ...base, name: "b" });
  expect(store.update(a.id, { nextRunAt: 5, lastStatus: "ok" })).toMatchObject({ nextRunAt: 5 });
  expect(store.update(a.id, { nextRunAt: undefined })!.nextRunAt).toBeUndefined();
  expect(store.setEnabled(b.id, false)!.enabled).toBe(false);
  expect(store.get(b.id)!.enabled).toBe(false);
  expect(store.remove(a.id)).toBe(true);
  expect(store.remove(a.id)).toBe(false);
  expect(store.list().map((j) => j.id)).toEqual([b.id]);
  expect(store.update("missing", {})).toBeUndefined();
});

test("find accepts a unique prefix and refuses an ambiguous one", () => {
  const store = new CronStore(home);
  const a = store.add(base);
  expect(store.find(a.id.slice(0, 4))!.id).toBe(a.id);
  expect(store.find("zzzz")).toBeUndefined();
  writeFileSync(store.jobsPath, JSON.stringify({ version: 1, jobs: [{ ...a, id: "abc1" }, { ...a, id: "abc2" }] }));
  expect(() => store.find("abc")).toThrow(/matches 2 jobs/);
  expect(store.find("abc1")!.id).toBe("abc1");
});

test("a corrupt file reads as empty, is kept aside, and the next add works", () => {
  const store = new CronStore(home, { now: () => 7 });
  store.add(base);
  writeFileSync(store.jobsPath, "{ not json");
  expect(store.list()).toEqual([]);
  expect(readdirSync(store.dir).some((f) => f.startsWith("jobs.json.corrupt-"))).toBe(true);
  store.add(base);
  expect(store.list()).toHaveLength(1);
});

test("invalid entries are skipped, valid ones kept", () => {
  const store = new CronStore(home);
  const a = store.add(base);
  writeFileSync(store.jobsPath, JSON.stringify({ version: 1, jobs: [a, { id: "bad", name: "x", schedule: { kind: "every", ms: 5 }, prompt: "p", createdAt: 1 }, 7, null] }));
  expect(store.list().map((j) => j.id)).toEqual([a.id]);
  writeFileSync(store.jobsPath, JSON.stringify({ jobs: "nope" }));
  expect(store.list()).toEqual([]);
});

test("a missing file is an empty store; mtimeMs is 0", () => {
  const store = new CronStore(home);
  expect(store.list()).toEqual([]);
  expect(store.mtimeMs()).toBe(0);
  store.add(base);
  expect(store.mtimeMs()).toBeGreaterThan(0);
});

test("runs are appended 0600, newest first per job, summary clipped", () => {
  const store = new CronStore(home);
  store.appendRun(run("a", 1));
  store.appendRun(run("b", 2));
  store.appendRun(run("a", 3, "x".repeat(900)));
  expect(mode(store.runsPath)).toBe(0o600);
  const runs = store.runs("a");
  expect(runs.map((r) => r.runId)).toEqual(["r3", "r1"]);
  expect(runs[0]!.summary).toHaveLength(500);
  expect(store.runs("a", 1)).toHaveLength(1);
});

test("a torn line in runs.jsonl is ignored", () => {
  const store = new CronStore(home);
  store.appendRun(run("a", 1));
  writeFileSync(store.runsPath, `${readFileSync(store.runsPath, "utf8")}{"jobId":"a","ru`, { mode: 0o600 });
  expect(store.runs("a").map((r) => r.runId)).toEqual(["r1"]);
});

test("runs.jsonl rotates to runs.jsonl.1 at the size cap and history still reads across it", () => {
  const store = new CronStore(home, { rotateBytes: 600 });
  for (let i = 0; i < 12; i++) store.appendRun(run("a", i, "y".repeat(100)));
  expect(existsSync(`${store.runsPath}.1`)).toBe(true);
  expect(mode(`${store.runsPath}.1`)).toBe(0o600);
  expect(statSync(store.runsPath).size).toBeLessThan(900);
  const ids = store.runs("a", 50).map((r) => r.runId);
  expect(ids[0]).toBe("r11");
  expect(ids.length).toBeGreaterThan(5);
});
