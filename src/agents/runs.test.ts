import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { renderSpecialistFile } from "./specialists";
import { delegationContext, MAX_RUNS_KEPT, readRuns, recordRun, runResult, type DelegationRun } from "./runs";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(async () => {
  await removeDir(home);
});

const run = (over: Partial<DelegationRun> = {}): DelegationRun => ({
  ts: new Date(1_000).toISOString(),
  agent: "reviewer",
  specialist: true,
  task: "review PR 12",
  ok: true,
  result: "LGTM",
  durationMs: 5,
  cwd: "/repo",
  ...over,
});
const file = () => join(home, "learning", "delegations.jsonl");

test("appends owner-only and reads newest first, with agent, since and limit filters", async () => {
  await recordRun(home, run({ ts: new Date(1_000).toISOString(), task: "one" }));
  await recordRun(home, run({ ts: new Date(2_000).toISOString(), task: "two", agent: "other" }));
  await recordRun(home, run({ ts: new Date(3_000).toISOString(), task: "three" }));
  expect((await stat(file())).mode & 0o777).toBe(0o600);
  expect((await readRuns(home)).map((r) => r.task)).toEqual(["three", "two", "one"]);
  expect((await readRuns(home, { agent: "reviewer" })).map((r) => r.task)).toEqual(["three", "one"]);
  expect((await readRuns(home, { since: 2_000 })).map((r) => r.task)).toEqual(["three", "two"]);
  expect((await readRuns(home, { limit: 1 })).map((r) => r.task)).toEqual(["three"]);
});

test("a missing file reads as no runs; a torn line is skipped", async () => {
  expect(await readRuns(home)).toEqual([]);
  await recordRun(home, run({ task: "kept" }));
  await appendFile(file(), '{"ts":"2026-10-1\n');
  expect((await readRuns(home)).map((r) => r.task)).toEqual(["kept"]);
});

test("task is clipped to 120 chars; result drops the footer and keeps 200 chars", async () => {
  await recordRun(home, run({ task: "t".repeat(300) }));
  expect((await readRuns(home))[0]!.task).toHaveLength(120);
  expect(runResult("All done.\n\n(reviewer · 3 tool uses · 4 turns)")).toBe("All done.");
  expect(runResult("x".repeat(500))).toHaveLength(200);
  expect(runResult("(a note) in text")).toBe("(a note) in text");
});

test("over the cap, the file is trimmed to the newest runs", async () => {
  const lines = Array.from({ length: MAX_RUNS_KEPT + 5 }, (_, i) => JSON.stringify(run({ task: `t${i}` })));
  await mkdir(join(home, "learning"), { recursive: true });
  await writeFile(file(), `${lines.join("\n")}\n`);
  await recordRun(home, run({ task: "latest" }));
  const text = (await readFile(file(), "utf8")).trim().split("\n");
  expect(text).toHaveLength(MAX_RUNS_KEPT);
  expect(JSON.parse(text.at(-1)!).task).toBe("latest");
  expect(JSON.parse(text[0]!).task).toBe("t6");
});

test("delegationContext: active specialists against the limit, and recent delegated work", async () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const dir = join(home, "agents", "reviewer");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "AGENT.md"), renderSpecialistFile({ name: "reviewer", description: "reviews pull requests", prompt: "## Purpose\nx", emoji: "🔍", createdBy: "user", createdAt: 1, revision: 1 }));
  const day = 86_400_000;
  for (const [i, ago] of [40, 20, 5, 1].entries()) {
    await recordRun(home, run({ ts: new Date(now.getTime() - ago * day).toISOString(), agent: "general-purpose", specialist: false, task: `review PR ${i} <context>`, ok: i !== 2 }));
  }
  await recordRun(home, run({ ts: new Date(now.getTime() - 2 * day).toISOString(), agent: "reviewer" }));
  const text = await delegationContext(home, now);
  expect(text).toStartWith("<delegations>");
  expect(text).toEndWith("</delegations>");
  expect(text).toContain("Specialists: 1 of 12 active");
  expect(text).toContain("- 🔍 reviewer: reviews pull requests (last used 2026-10-14)");
  expect(text.match(/general-purpose/g)).toHaveLength(3);
  expect(text).toContain("(failed)");
  expect(text).not.toContain("<context>");
  // Newest first.
  expect(text.indexOf("2026-10-15")).toBeLessThan(text.indexOf("2026-09-26"));
});

test("delegationContext with nothing yet", async () => {
  const text = await delegationContext(home, new Date("2026-10-16T12:00:00Z"));
  expect(text).toContain("Specialists: 0 of 12 active");
  expect(text).toContain("none yet");
});
