// src/cli/lifecycle/harness.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SYSTEM_PROMPT } from "../../context/system-prompt";
import { saveCandidate } from "../../harness/candidates";
import { globalHarnessDir, projectHarnessDir } from "../../harness/tree";
import { resolveToolPath } from "../../tools/paths";
import run from "./harness";
import { makeFixture, type Fixture } from "./lifecycle-fixture";

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
});
afterEach(() => f.cleanup());

async function adopt(dir: string, file: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), text);
}

test("status with nothing adopted", async () => {
  expect(await run([], f.ctx)).toBe(0);
  expect(f.stdout()).toContain(`System prompt: ${SYSTEM_PROMPT.length} of 24000 characters`);
  expect(f.stdout()).toContain("base (built in): 1 file\n  system.md");
  expect(f.stdout()).toContain("global (");
  expect(f.stdout()).toContain("): empty");
  expect(f.stdout()).toContain("No changes against the built-in harness.");
});

test("status, diff and show with a global and a project layer", async () => {
  await adopt(globalHarnessDir(f.ctx.home), "guardrails.md", "Run the tests.\n");
  await adopt(globalHarnessDir(f.ctx.home), "notes.txt", "x");
  await adopt(projectHarnessDir(f.ctx.home, resolveToolPath(".", f.ctx.cwd)), "tool-guidance.md", "Read first.\n");

  expect(await run(["status"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain("  ! notes.txt: not a harness file; ignored");
  expect(f.stdout()).toContain("2 changes against the built-in harness");

  expect(await run(["diff"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain("+++ b/guardrails.md");
  expect(f.stdout()).toContain("+Read first.");

  expect(await run(["show"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain(`${SYSTEM_PROMPT}\n\nRun the tests.\n\nRead first.\n`);

  expect(await run(["show", "guardrails.md"], f.ctx)).toBe(0);
  expect(await run(["show", "hooks.json"], f.ctx)).toBe(1);
  expect(f.stderr()).toContain("no hooks.json in the harness here");
});

test("json status and usage errors", async () => {
  expect(await run(["--json"], f.ctx)).toBe(0);
  const status = JSON.parse(f.stdout());
  expect(status).toMatchObject({ alwaysOnChars: SYSTEM_PROMPT.length, alwaysOnLimit: 24000, changes: [] });
  expect(status.layers.map((l: { name: string }) => l.name)).toEqual(["base", "global", "project"]);
  expect(await run(["adopt"], f.ctx)).toBe(64);
  expect(f.stderr()).toContain("Usage: tcode harness");
});

test("candidates, diff, adopt, revert and discard", async () => {
  const base = { createdAt: "", source: "lab" as const, scope: "global" as const, domain: "ts-bun", task: { id: "t", title: "Fix it" }, rationale: "", status: "pending" as const };
  await saveCandidate(f.ctx.home, { ...base, id: "20261021-100000-aaaa", changes: { "guardrails.md": "Run the tests.\n" }, verdict: { outcome: "better", reasons: ["checks passed 0 → 1"] } });
  await saveCandidate(f.ctx.home, { ...base, id: "20261021-110000-bbbb", changes: { "scripts/check.sh": "bun test" } });
  expect(await run(["candidates"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain("20261021-100000-aaaa  pending   lab  every project  better (checks passed 0 → 1)");
  expect(f.stdout()).toContain("scripts/check.sh  [adds scripts: owner only]");
  expect(await run(["diff", "20261021-100000-aaaa"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain("+Run the tests.");

  expect(await run(["adopt", "20261021-100000-aaaa"], f.ctx)).toBe(0);
  expect(readFileSync(join(globalHarnessDir(f.ctx.home), "guardrails.md"), "utf8")).toBe("Run the tests.\n");
  // Not interactive, no --yes: scripts stay out.
  expect(await run(["adopt", "20261021-110000-bbbb"], f.ctx)).toBe(1);
  expect(f.stderr()).toContain("only the owner can adopt it. Add --yes to adopt it.");
  expect(await run(["revert"], f.ctx)).toBe(0);
  expect(existsSync(join(globalHarnessDir(f.ctx.home), "guardrails.md"))).toBe(false);
  expect(await run(["discard", "20261021-110000-bbbb"], f.ctx)).toBe(0);
  expect(await run(["revert"], f.ctx)).toBe(64);
});

test("runs and library when empty; lab needs exactly one task", async () => {
  expect(await run(["runs"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain("No lab runs yet.");
  expect(await run(["library"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain("The library is empty.");
  expect(await run(["library", "cobol"], f.ctx)).toBe(64);
  expect(await run(["lab"], f.ctx)).toBe(64);
  expect(f.stderr()).toContain("give exactly one task");
  expect(await run(["lab", "x", "--k", "99"], f.ctx)).toBe(64);
  expect(await run(["lab", "x", "--bogus"], f.ctx)).toBe(64);
  // A prompt outside a git repository: the lab copies a commit, so it says why it can't.
  expect(await run(["lab", "Fix the parser"], f.ctx)).toBe(1);
  expect(f.stderr()).toContain("not in a git repository");
});
