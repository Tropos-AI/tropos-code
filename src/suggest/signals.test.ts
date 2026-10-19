import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { CronStore } from "../gateway/cron/store";
import { updateOnboardingFlags } from "../onboard/flags";
import { localDate } from "../memory/daily";
import { journalDir } from "../paths";
import { computeSignals, gatherFacts, suggestionContext, suggestionsBlock, type SignalFacts } from "./signals";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16, 12);
const FACTS: SignalFacts = { setupOpen: ["telegram"], failingJobs: [], journalDays: 0, cronJobs: 1 };
const EMPTY = { declined: {}, mentioned: {}, tests: {} };

test("a skipped setup step is suggested once, ever", () => {
  expect(computeSignals(FACTS, EMPTY, NOW).map((s) => s.id)).toEqual(["setup:telegram"]);
  expect(computeSignals(FACTS, { ...EMPTY, mentioned: { "setup:telegram": NOW - 90 * DAY } }, NOW)).toEqual([]);
  expect(computeSignals({ ...FACTS, setupOpen: [] }, EMPTY, NOW)).toEqual([]); // reminded (P4's list) or done since
});

test("declined signals never come back; others come back after a week", () => {
  const facts = { ...FACTS, setupOpen: [], failingJobs: [{ id: "j1", name: "digest", error: "timed out" }] };
  expect(computeSignals(facts, { ...EMPTY, declined: { "cron-failing:j1": 1 } }, NOW)).toEqual([]);
  expect(computeSignals(facts, { ...EMPTY, mentioned: { "cron-failing:j1": NOW - 3 * DAY } }, NOW)).toEqual([]);
  expect(computeSignals(facts, { ...EMPTY, mentioned: { "cron-failing:j1": NOW - 8 * DAY } }, NOW).map((s) => s.id)).toEqual(["cron-failing:j1"]);
});

test("failing tests, a routine without jobs, and at most three", () => {
  const s = computeSignals(
    { ...FACTS, setupOpen: ["telegram", "phone", "service"], journalDays: 6, cronJobs: 0 },
    { ...EMPTY, tests: { app: { ok: false, at: NOW, command: "bun test" } } },
    NOW,
  );
  expect(s).toHaveLength(3);
  const only = computeSignals({ ...FACTS, setupOpen: [], journalDays: 6, cronJobs: 0 }, { ...EMPTY, tests: { app: { ok: false, at: NOW, command: "bun test" }, web: { ok: true, at: NOW, command: "x" } } }, NOW);
  expect(only.map((x) => x.id)).toEqual(["tests-failing:app", "routine"]);
  expect(computeSignals({ ...FACTS, setupOpen: [], journalDays: 4, cronJobs: 0 }, EMPTY, NOW)).toEqual([]);
});

test("setup text comes from P4's reminder topics", () => {
  expect(computeSignals(FACTS, EMPTY, NOW)[0]!.text).toContain("Telegram, so they can talk to you from their phone");
});

test("the block is empty without signals", () => expect(suggestionsBlock([])).toBe(""));
test("the block lists one line per signal", () => {
  const block = suggestionsBlock([{ id: "routine", text: "a routine" }]);
  expect(block).toBe("<suggestions>\n- [routine] a routine\n</suggestions>");
});

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("suggest-signals-");
});
afterEach(() => removeDir(home));

test("facts: open skipped steps minus the reminded ones, failing jobs, journal days, job count", async () => {
  await updateOnboardingFlags(home, { skipped: ["telegram", "phone", "service"], reminded: ["phone"] });
  const store = new CronStore(home);
  const job = store.add({ name: "digest", schedule: { kind: "every", ms: 3_600_000 }, prompt: "x" });
  store.update(job.id, { lastStatus: "error" });
  store.appendRun({ jobId: job.id, runId: "r1", startedAt: 1, endedAt: 2, status: "error", summary: "", error: "boom" });
  await mkdir(journalDir(home), { recursive: true });
  const day = (n: number) => localDate(new Date(Date.now() - n * DAY));
  for (const n of [0, 1, 2, 20]) await writeFile(join(journalDir(home), `${day(n)}.md`), "- x\n");
  const facts = await gatherFacts({ home, env: { HOME: home }, serviceInstalled: async () => false, now: Date.now() });
  expect(facts.setupOpen).toEqual(["telegram", "service"]);
  expect(facts.failingJobs).toEqual([{ id: job.id, name: "digest", error: "boom" }]);
  expect(facts.journalDays).toBe(3);
  expect(facts.cronJobs).toBe(1);
});

test("the context block caches the service status for ten minutes", async () => {
  await updateOnboardingFlags(home, { skipped: ["service"] });
  let asked = 0;
  let t = 1_000_000;
  const ctx = suggestionContext({ home, env: { HOME: home }, serviceInstalled: async () => (asked++, false), now: () => t });
  const first = await ctx();
  expect(first[0]).toContain("[setup:service]");
  t += 5 * 60_000;
  await ctx();
  expect(asked).toBe(1);
  t += 6 * 60_000;
  await ctx();
  expect(asked).toBe(2);
});

test("no signals means no block at all", async () => {
  const ctx = suggestionContext({ home, env: { HOME: home }, serviceInstalled: async () => true });
  expect(await ctx()).toEqual([]);
});
