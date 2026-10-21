// src/harness/candidates.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { Ledger } from "../learning/ledger";
import { adoptCandidate, candidateRunsCode, discardCandidate, listCandidates, newId, readCandidate, revertCandidate, saveCandidate, type Candidate } from "./candidates";
import { globalHarnessDir, projectHarnessDir } from "./tree";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("cand-");
});
afterEach(() => removeDir(home));

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: "20261021-120000-abcd",
  createdAt: "2026-10-21T12:00:00Z",
  source: "lab",
  scope: "global",
  domain: "ts-bun",
  task: { id: "t1", title: "Fix the parser" },
  changes: { "guardrails.md": "Run the tests.\n", "tool-guidance.md": null },
  verdict: { outcome: "better", reasons: ["checks passed 1 → 2"] },
  rationale: "verify",
  status: "pending",
  ...over,
});

test("ids sort by time", () => {
  expect(newId(new Date("2026-10-21T09:08:07Z"))).toMatch(/^20261021-090807-[0-9a-f]{4}$/);
});

test("save, read, list and the evidence file", async () => {
  await saveCandidate(home, candidate());
  await saveCandidate(home, candidate({ id: "20261022-120000-abcd" }));
  expect((await listCandidates(home)).map((c) => c.id)).toEqual(["20261022-120000-abcd", "20261021-120000-abcd"]);
  expect(await readCandidate(home, "../etc")).toBeNull();
  const evidence = readFileSync(join(home, "harness", "candidates", "20261021-120000-abcd", "EVIDENCE.md"), "utf8");
  expect(evidence).toContain("Verdict: better\n- checks passed 1 → 2");
  expect(evidence).toContain("- tool-guidance.md: removed");
  await expect(saveCandidate(home, candidate({ id: "x/../../y" }))).rejects.toThrow("bad candidate id");
});

test("adopt writes through the ledger, revert takes it back", async () => {
  const layer = globalHarnessDir(home);
  await mkdir(layer, { recursive: true });
  await writeFile(join(layer, "tool-guidance.md"), "old guidance");
  await saveCandidate(home, candidate());
  const ledger = new Ledger(home);
  const adopted = await adoptCandidate(home, "20261021-120000-abcd", { ledger, actor: "user" });
  expect(adopted.ok).toBe(true);
  expect(readFileSync(join(layer, "guardrails.md"), "utf8")).toBe("Run the tests.\n");
  expect(existsSync(join(layer, "tool-guidance.md"))).toBe(false);
  expect((await ledger.list()).map((e) => [e.kind, e.action, e.summary])).toEqual([
    ["harness", "remove", "harness 20261021-120000-abcd: tool-guidance.md"],
    ["harness", "create", "harness 20261021-120000-abcd: guardrails.md"],
  ]);
  expect((await adoptCandidate(home, "20261021-120000-abcd", { ledger, actor: "user" })).ok).toBe(false);

  const reverted = await revertCandidate(home, "20261021-120000-abcd", ledger);
  expect(reverted).toMatchObject({ ok: true, candidate: { status: "reverted" } });
  expect(existsSync(join(layer, "guardrails.md"))).toBe(false);
  expect(readFileSync(join(layer, "tool-guidance.md"), "utf8")).toBe("old guidance");
});

test("a project candidate goes to that project's layer", async () => {
  await saveCandidate(home, candidate({ scope: "project", project: "/work/app", changes: { "skills/x/SKILL.md": "x" } }));
  expect((await adoptCandidate(home, "20261021-120000-abcd", { ledger: new Ledger(home), actor: "review" })).ok).toBe(true);
  expect(readFileSync(join(projectHarnessDir(home, "/work/app"), "skills", "x", "SKILL.md"), "utf8")).toBe("x");
});

test("scripts need the owner; files off the surface are never adopted; discard", async () => {
  const scripts = candidate({ changes: { "scripts/check.sh": "bun test" } });
  expect(candidateRunsCode(scripts)).toBe(true);
  expect(candidateRunsCode(candidate())).toBe(false);
  await saveCandidate(home, scripts);
  const ledger = new Ledger(home);
  expect(await adoptCandidate(home, scripts.id, { ledger, actor: "review" })).toEqual({ ok: false, reason: `Candidate ${scripts.id} adds or changes scripts; only the owner can adopt it.` });
  expect((await adoptCandidate(home, scripts.id, { ledger, actor: "user", allowCode: true })).ok).toBe(true);

  await saveCandidate(home, candidate({ id: "20261023-000000-0000", changes: { "settings.json": "{}" } }));
  expect((await adoptCandidate(home, "20261023-000000-0000", { ledger, actor: "user", allowCode: true })).ok).toBe(false);
  expect(await discardCandidate(home, "20261023-000000-0000")).toMatchObject({ ok: true, candidate: { status: "discarded" } });
  expect((await discardCandidate(home, "20261023-000000-0000")).ok).toBe(false);
});

test("a candidate that would push its layer over the budget is refused", async () => {
  await saveCandidate(home, candidate({ changes: { "tool-guidance.md": "x".repeat(30_000) } }));
  const r = await adoptCandidate(home, "20261021-120000-abcd", { ledger: new Ledger(home), actor: "user" });
  expect(r.ok).toBe(false);
  expect(!r.ok && r.reason).toContain("would break its layer");
});
