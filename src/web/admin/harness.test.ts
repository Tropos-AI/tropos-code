// src/web/admin/harness.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { saveCandidate, type Candidate } from "../../harness/candidates";
import { SYSTEM_PROMPT } from "../../context/system-prompt";
import { globalHarnessDir } from "../../harness/tree";
import type { HarnessOverview } from "./api";
import { harnessHandlers } from "./harness";
import { adminWith, failure, makeKit, type Kit } from "./host-testkit";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.close());
const admin = () => adminWith(kit, harnessHandlers(kit.ctx));

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: "20261021-100000-aaaa", createdAt: "2026-10-21T10:00:00Z", source: "lab", scope: "global", domain: "ts-bun", task: { id: "t", title: "Fix the parser" },
  changes: { "guardrails.md": "- Run the tests.\n" }, verdict: { outcome: "better", reasons: ["checks passed 0 → 1"] }, rationale: "it helped", status: "pending",
  ...over,
});

test("the overview: layers, budget, candidates and settings", async () => {
  await saveCandidate(kit.home, candidate());
  await saveCandidate(kit.home, candidate({ id: "20261021-110000-bbbb", source: "review", changes: { "scripts/x.sh": "echo" }, verdict: undefined }));
  const o = (await admin().handle("harness.overview", undefined)) as HarnessOverview;
  expect(o.layers.map((l) => [l.name, l.files])).toEqual([["base", ["system.md"]], ["global", []]]);
  expect(o.alwaysOnChars).toBe(SYSTEM_PROMPT.length);
  expect(o.candidates.map((c) => [c.id, c.source, c.runsCode, c.files])).toEqual([
    ["20261021-110000-bbbb", "review", true, [{ path: "scripts/x.sh", change: "write" }]],
    ["20261021-100000-aaaa", "lab", false, [{ path: "guardrails.md", change: "write" }]],
  ]);
  expect(o.settings).toMatchObject({ lab: false, autoAdopt: true, lessons: true, suggest: true });
  expect(o.runs).toEqual([]);
  expect(o.library).toEqual([]);
});

test("diff, adopt, revert and discard, and scripts only with allowCode", async () => {
  await saveCandidate(kit.home, candidate());
  await saveCandidate(kit.home, candidate({ id: "20261021-110000-bbbb", changes: { "scripts/x.sh": "echo" } }));
  const a = admin();
  expect(((await a.handle("harness.diff", { id: "20261021-100000-aaaa" })) as { patch: string }).patch).toContain("+- Run the tests.");
  await a.handle("harness.adopt", { id: "20261021-100000-aaaa" });
  expect(readFileSync(join(globalHarnessDir(kit.home), "guardrails.md"), "utf8")).toBe("- Run the tests.\n");
  expect(await failure(a, "harness.adopt", { id: "20261021-110000-bbbb" })).toContain("only the owner can adopt it");
  const adopted = (await a.handle("harness.adopt", { id: "20261021-110000-bbbb", allowCode: true })) as HarnessOverview;
  expect(adopted.candidates.every((c) => c.status === "adopted")).toBe(true);
  await a.handle("harness.revert", { id: "20261021-100000-aaaa" });
  expect(existsSync(join(globalHarnessDir(kit.home), "guardrails.md"))).toBe(false);
  expect(await failure(a, "harness.discard", { id: "20261021-100000-aaaa" })).toContain("is reverted");
  expect(await failure(a, "harness.adopt", { id: "../x" })).toBe("That isn't a harness candidate.");
});

test("settings are written to settings.json, validated, and only the harness keys", async () => {
  const a = admin();
  const o = (await a.handle("harness.settings", { lab: true, tasksPerWeek: 4 })) as HarnessOverview;
  expect(o.settings).toMatchObject({ lab: true, tasksPerWeek: 4 });
  expect(JSON.parse(readFileSync(join(kit.home, "settings.json"), "utf8")).harness).toEqual({ lab: true, tasksPerWeek: 4 });
  expect(await failure(a, "harness.settings", { tasksPerWeek: 50 })).toContain("tasksPerWeek");
  expect(await failure(a, "harness.settings", {})).toBe("Say which harness setting to change.");
  await a.handle("harness.settings", { editorModel: "claude-opus-5-5" });
  await a.handle("harness.settings", { editorModel: "" });
  expect(JSON.parse(readFileSync(join(kit.home, "settings.json"), "utf8")).harness.editorModel).toBeUndefined();
});

test("a global layer over the budget shows as skipped, with why", async () => {
  await mkdir(globalHarnessDir(kit.home), { recursive: true });
  await writeFile(join(globalHarnessDir(kit.home), "tool-guidance.md"), "x".repeat(30_000));
  const o = (await admin().handle("harness.overview", undefined)) as HarnessOverview;
  expect(o.layers[1]).toMatchObject({ applied: false });
  expect(o.layers[1]!.problems[0]).toContain("over the 24000 limit");
  expect(o.alwaysOnChars).toBe(SYSTEM_PROMPT.length);
});
