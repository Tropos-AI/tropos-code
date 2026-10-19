import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { Ledger } from "../learning/ledger";
import { loadSpecialists } from "./specialists";
import {
  archiveSpecialist,
  createdByFor,
  createSpecialist,
  restoreSpecialist,
  ROLE_CONTRACT_TEMPLATE,
  SpecialistError,
  undoSpecialist,
  updateSpecialist,
} from "./store";

let home: string;
let ledger: Ledger;
beforeEach(async () => {
  home = await makeTmpDir();
  ledger = new Ledger(home);
});
afterEach(() => removeDir(home));

const CONTRACT = "## Purpose\nReviews pull requests.\n## Not my job\nMerging.\n## Report\nFindings with path:line.\n## Escalate when\nThe diff is missing.";
const INPUT = { id: "reviewer", description: "reviews pull requests", prompt: CONTRACT, emoji: "🔍", tools: ["Read", "Grep"] };
const opts = () => ({ ledger, actor: "review" as const });

test("create writes AGENT.md at revision 1 and records it; undo removes the file and the empty folder", async () => {
  const s = await createSpecialist(home, INPUT, { ledger, actor: "review", now: new Date("2026-10-16T10:00:00Z") });
  expect(s).toMatchObject({ id: "reviewer", revision: 1, createdBy: "review", createdAt: Date.parse("2026-10-16T10:00:00Z") });
  expect((await ledger.list())[0]).toMatchObject({ kind: "agent", action: "create", summary: "created specialist 🔍 reviewer — reviews pull requests" });
  expect((await ledger.undo()).ok).toBe(true);
  expect(existsSync(join(home, "agents", "reviewer"))).toBe(false);
});

test("names: kebab-case, not a built-in, not an existing plain agent or specialist", async () => {
  for (const id of ["Bad", "a_b", "explore", "x".repeat(41)]) await expect(createSpecialist(home, { ...INPUT, id }, opts())).rejects.toThrow(SpecialistError);
  await writeFile(join(home, "agents", "plain.md"), "---\nname: plain\ndescription: d\n---\nx").catch(async () => {
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(join(home, "agents", "plain.md"), "---\nname: plain\ndescription: d\n---\nx");
  });
  await expect(createSpecialist(home, { ...INPUT, id: "plain" }, opts())).rejects.toThrow(/already/);
  await createSpecialist(home, INPUT, opts());
  await expect(createSpecialist(home, INPUT, opts())).rejects.toThrow(/already/);
});

test("a symlinked folder of that name is refused and nothing is written through it", async () => {
  const outside = await makeTmpDir();
  try {
    await mkdir(join(home, "agents"), { recursive: true });
    await symlink(outside, join(home, "agents", "reviewer"));
    await expect(createSpecialist(home, INPUT, opts())).rejects.toThrow(SpecialistError);
    expect(existsSync(join(outside, "AGENT.md"))).toBe(false);
  } finally {
    await removeDir(outside);
  }
});

test("the chief and the review must write a role contract; the user need not", async () => {
  await expect(createSpecialist(home, { ...INPUT, prompt: "Review things." }, { ledger, actor: "agent" })).rejects.toThrow("## Purpose, ## Not my job, ## Report and ## Escalate when");
  await createSpecialist(home, { ...INPUT, prompt: "Review things." }, { ledger, actor: "user" });
  expect(ROLE_CONTRACT_TEMPLATE).toContain("## Escalate when");
});

test("bad fields are refused as SpecialistError", async () => {
  await expect(createSpecialist(home, { ...INPUT, description: "two\nlines" }, opts())).rejects.toThrow(SpecialistError);
  await expect(createSpecialist(home, { ...INPUT, emoji: "no" }, opts())).rejects.toThrow(SpecialistError);
});

test("the 13th is refused with how to free a slot", async () => {
  for (let i = 0; i < 12; i++) await createSpecialist(home, { ...INPUT, id: `s${i}` }, opts());
  await expect(createSpecialist(home, { ...INPUT, id: "s12" }, opts())).rejects.toThrow("12 specialists are active, the limit. Archive one or fold this role into the closest one first: s0, s1,");
});

test("update writes the old file to revisions/<n>.md and bumps the revision; undo restores it", async () => {
  await createSpecialist(home, INPUT, opts());
  const s = await updateSpecialist(home, "reviewer", { model: "haiku" }, opts());
  expect(s.revision).toBe(2);
  expect(s.model).toBe("haiku");
  expect(await readFile(join(home, "agents/reviewer/revisions/1.md"), "utf8")).toContain("revision: 1");
  expect((await ledger.list())[0]).toMatchObject({ action: "update", summary: "updated specialist 🔍 reviewer: model" });
  expect((await undoSpecialist(home, "reviewer", ledger)).ok).toBe(true);
  const [back] = await loadSpecialists(home);
  expect(back).toMatchObject({ revision: 1 });
  expect(back!.model).toBeUndefined();
});

test("null unsets a field; a chief edit of the prompt must keep the contract", async () => {
  await createSpecialist(home, { ...INPUT, model: "haiku" }, opts());
  const s = await updateSpecialist(home, "reviewer", { model: null, emoji: null }, opts());
  expect(s.model).toBeUndefined();
  expect(s.emoji).toBeUndefined();
  await expect(updateSpecialist(home, "reviewer", { prompt: "nope" }, { ledger, actor: "agent" })).rejects.toThrow("## Purpose");
  await expect(updateSpecialist(home, "nobody", { model: "x" }, opts())).rejects.toThrow(/No specialist/);
});

test("pausing changes no revision; a stale expectedRevision is refused", async () => {
  await createSpecialist(home, INPUT, opts());
  expect(await updateSpecialist(home, "reviewer", { paused: true }, opts())).toMatchObject({ paused: true, revision: 1 });
  expect((await ledger.list())[0]!.summary).toBe("paused specialist 🔍 reviewer");
  expect(existsSync(join(home, "agents/reviewer/revisions"))).toBe(false);
  await updateSpecialist(home, "reviewer", { paused: false }, opts());
  expect((await ledger.list())[0]!.summary).toBe("resumed specialist 🔍 reviewer");
  await expect(updateSpecialist(home, "reviewer", { description: "x" }, { ...opts(), expectedRevision: 0 })).rejects.toThrow("reviewer changed since you opened it (now revision 1); reload and try again.");
});

test("archive moves the folder under .archive; restore moves it back and refuses a taken id or a full roster", async () => {
  await createSpecialist(home, INPUT, opts());
  const dir = await archiveSpecialist(home, "reviewer", { ...opts(), now: new Date("2026-10-16T00:00:00Z") });
  expect(dir).toBe(join(home, "agents", ".archive", "reviewer-2026-10-16"));
  await createSpecialist(home, INPUT, opts());
  await expect(restoreSpecialist(home, "reviewer-2026-10-16", opts())).rejects.toThrow(/already/);
  await archiveSpecialist(home, "reviewer", opts());
  expect((await restoreSpecialist(home, "reviewer-2026-10-16", opts())).archived).toBeUndefined();
  await expect(restoreSpecialist(home, "../x", opts())).rejects.toThrow(SpecialistError);
  await expect(restoreSpecialist(home, "missing", opts())).rejects.toThrow(SpecialistError);
  await expect(archiveSpecialist(home, "ghost", opts())).rejects.toThrow(SpecialistError);
});

test("restore refuses when twelve are active", async () => {
  await createSpecialist(home, INPUT, opts());
  await archiveSpecialist(home, "reviewer", { ...opts(), now: new Date("2026-10-16T00:00:00Z") });
  for (let i = 0; i < 12; i++) await createSpecialist(home, { ...INPUT, id: `s${i}` }, opts());
  await expect(restoreSpecialist(home, "reviewer-2026-10-16", opts())).rejects.toThrow("12 specialists are active");
});

test("archive and restore are ledger entries, and undo moves the whole folder back", async () => {
  await createSpecialist(home, INPUT, opts());
  await writeFile(join(home, "agents/reviewer/MEMORY.md"), "remember\n");
  await archiveSpecialist(home, "reviewer", { ...opts(), now: new Date("2026-10-16T00:00:00Z") });
  expect((await ledger.list())[0]).toMatchObject({ kind: "agent", action: "archive", summary: "archived specialist 🔍 reviewer" });
  expect((await undoSpecialist(home, "reviewer", ledger)).ok).toBe(true);
  expect(await readFile(join(home, "agents/reviewer/MEMORY.md"), "utf8")).toBe("remember\n");
  expect(existsSync(join(home, "agents/.archive/reviewer-2026-10-16"))).toBe(false);
  expect((await loadSpecialists(home)).map((s) => [s.id, s.archived ?? false])).toEqual([["reviewer", false]]);

  await archiveSpecialist(home, "reviewer", { ...opts(), now: new Date("2026-10-17T00:00:00Z") });
  await restoreSpecialist(home, "reviewer-2026-10-17", opts());
  expect((await ledger.list())[0]).toMatchObject({ action: "restore", summary: "restored specialist 🔍 reviewer" });
  expect((await undoSpecialist(home, "reviewer", ledger)).ok).toBe(true);
  expect(existsSync(join(home, "agents/reviewer"))).toBe(false);
  expect((await loadSpecialists(home)).map((s) => [s.id, s.archived ?? false])).toEqual([["reviewer", true]]);
  const [archived] = await loadSpecialists(home);
  expect(await readFile(join(archived!.dir, "MEMORY.md"), "utf8")).toBe("remember\n");
});

test("undo with nothing recorded says so", async () => {
  expect(await undoSpecialist(home, "reviewer", ledger)).toEqual({ ok: false, reason: "Nothing to undo for reviewer." });
});

test("createdByFor maps actors", () => {
  expect([createdByFor("agent"), createdByFor("review"), createdByFor("user")]).toEqual(["chief", "review", "user"]);
});

test("a symlinked .archive or revisions folder is refused and the outside is left untouched", async () => {
  const outside = await makeTmpDir();
  try {
    await createSpecialist(home, INPUT, opts());
    await symlink(outside, join(home, "agents", ".archive"));
    await expect(archiveSpecialist(home, "reviewer", opts())).rejects.toThrow(SpecialistError);
    expect(existsSync(join(home, "agents", "reviewer", "AGENT.md"))).toBe(true);
    expect(await readdir(outside)).toEqual([]);
    await expect(restoreSpecialist(home, "x", opts())).rejects.toThrow(SpecialistError);

    await symlink(outside, join(home, "agents", "reviewer", "revisions"));
    await expect(updateSpecialist(home, "reviewer", { model: "haiku" }, opts())).rejects.toThrow(SpecialistError);
    expect(await readdir(outside)).toEqual([]);
    expect((await loadSpecialists(home)).find((s) => s.id === "reviewer")!.revision).toBe(1);
  } finally {
    await removeDir(outside);
  }
});

test("undoing an archive never reads or removes through a symlinked archive entry", async () => {
  const outside = await makeTmpDir();
  try {
    await createSpecialist(home, INPUT, opts());
    const dir = await archiveSpecialist(home, "reviewer", { ...opts(), now: new Date("2026-10-16T00:00:00Z") });
    await writeFile(join(outside, "keep.md"), "keep");
    await rm(dir, { recursive: true });
    await symlink(outside, dir);
    await undoSpecialist(home, "reviewer", ledger);
    expect(await readFile(join(outside, "keep.md"), "utf8")).toBe("keep");
  } finally {
    await removeDir(outside);
  }
});
