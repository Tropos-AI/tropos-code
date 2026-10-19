// src/web/admin/agents.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MODEL } from "../../config/constants";
import { createSpecialist, updateSpecialist } from "../../agents/store";
import { recordRun } from "../../agents/runs";
import { Ledger } from "../../learning/ledger";
import { createAdmin } from "./index";
import { agentsHandlers } from "./agents";
import { AdminError } from "./context";
import { makeKit, writeText, type Kit } from "./ops-testkit";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.cleanup());

const CONTRACT = "## Purpose\nreview\n## Not my job\nx\n## Report\ny\n## Escalate when\nz";
const h = () => agentsHandlers(kit.ctx);
const ledger = () => new Ledger(kit.home);
const make = (id = "reviewer") => createSpecialist(kit.home, { id, description: "reviews PRs", prompt: CONTRACT, emoji: "🔍" }, { ledger: ledger(), actor: "user" });

test("a fresh home: only the chief, with the default model", async () => {
  expect(await h()["agents.roster"]!(undefined)).toEqual({ chief: { name: "Tropos", model: DEFAULT_MODEL }, specialists: [], archived: [], limit: 12 });
});

test("the chief shows the identity and the configured model", async () => {
  await writeText(join(kit.home, "workspace", "IDENTITY.md"), "- Name: Ada\n- Emoji: 🦊\n");
  await writeText(join(kit.home, "settings.json"), JSON.stringify({ model: "claude-sonnet-5-5" }));
  expect((await h()["agents.roster"]!(undefined)).chief).toEqual({ name: "Ada", emoji: "🦊", model: "claude-sonnet-5-5" });
});

test("a specialist's view carries runs, skills, memory, revisions and what Undo would revert", async () => {
  await make();
  await updateSpecialist(kit.home, "reviewer", { description: "reviews pull requests" }, { ledger: ledger(), actor: "user" });
  await writeText(join(kit.home, "agents", "reviewer", "MEMORY.md"), "x".repeat(42));
  await writeText(join(kit.home, "agents", "reviewer", "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: d\n---\nbody");
  for (const [ts, task] of [["2026-10-14T10:00:00Z", "first"], ["2026-10-15T10:00:00Z", "second"]] as const) {
    await recordRun(kit.home, { ts, agent: "reviewer", specialist: true, task, ok: true, result: "fine", durationMs: 1200, cwd: "/w" });
  }
  const [view] = (await h()["agents.roster"]!(undefined)).specialists;
  expect(view).toMatchObject({ id: "reviewer", emoji: "🔍", description: "reviews pull requests", createdBy: "user", revision: 2, paused: false, archived: false, skills: ["lint"], memoryChars: 42 });
  expect(view!.runs.map((r) => r.task)).toEqual(["second", "first"]);
  expect(view!.revisions.map((r) => r.revision)).toEqual([1]);
  expect(view!.undoable?.summary).toBe("updated specialist 🔍 reviewer: description");
});

test("update bumps the revision as the user; a stale revision is refused; the contract is free-form", async () => {
  await make();
  const r = await h()["agents.update"]!({ id: "reviewer", revision: 1, changes: { description: "better", contract: "just do it" } });
  expect(r.specialists[0]).toMatchObject({ revision: 2, description: "better", contract: "just do it" });
  expect((await ledger().list())[0]).toMatchObject({ actor: "user", kind: "agent" });
  await expect(h()["agents.update"]!({ id: "reviewer", revision: 1, changes: { description: "x" } })).rejects.toThrow(
    "reviewer changed since you opened it (now revision 2); reload and try again.",
  );
});

test("pause, archive, restore and undo round-trip", async () => {
  await make();
  expect((await h()["agents.setPaused"]!({ id: "reviewer", paused: true })).specialists[0]!.paused).toBe(true);
  const archived = await h()["agents.archive"]!({ id: "reviewer" });
  expect(archived.specialists).toEqual([]);
  expect(archived.archived).toHaveLength(1);
  const dir = archived.archived[0]!.archivedDir!;
  expect((await h()["agents.restore"]!({ dir })).specialists.map((s) => s.id)).toEqual(["reviewer"]);
  // undo walks back: restore, archive, pause.
  expect((await h()["agents.undo"]!({ id: "reviewer" })).archived).toHaveLength(1);
  expect((await h()["agents.undo"]!({ id: "reviewer" })).specialists[0]!.paused).toBe(true);
  expect((await h()["agents.undo"]!({ id: "reviewer" })).specialists[0]!.paused).toBe(false);
  await h()["agents.undo"]!({ id: "reviewer" }); // undoes the create
  await expect(h()["agents.undo"]!({ id: "reviewer" })).rejects.toThrow("Nothing to undo for reviewer.");
});

test("bad input is an AdminError", async () => {
  await make();
  await expect(h()["agents.archive"]!({ id: "../x" })).rejects.toBeInstanceOf(AdminError);
  await expect(h()["agents.archive"]!({ id: "nobody" })).rejects.toBeInstanceOf(AdminError);
  await expect(h()["agents.restore"]!({ dir: "../../etc" })).rejects.toBeInstanceOf(AdminError);
  await expect(h()["agents.setPaused"]!({ id: "nobody", paused: true })).rejects.toBeInstanceOf(AdminError);
});

test("the dispatcher exposes all six", () => {
  expect(createAdmin(kit.ctx).methods().filter((m) => m.startsWith("agents."))).toHaveLength(6);
});
