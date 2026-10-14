import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { runCurator } from "./curator";
import { Ledger } from "./ledger";
import type { Actor } from "../tools/types";
import { recordSkillUse } from "./skill-usage";

let home: string;
let outside: string;
const NOW = new Date("2026-10-14T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

beforeEach(async () => {
  home = await makeTmpDir();
  outside = await makeTmpDir();
});

afterEach(async () => {
  await removeDir(home);
  await removeDir(outside);
});

const skillFile = (name: string) => join(home, "skills", name, "SKILL.md");

async function makeSkill(name: string, opts: { actor?: Actor; at?: Date; pinned?: boolean; record?: boolean } = {}) {
  const text = `---\ndescription: ${name}\n${opts.pinned ? "pinned: true\n" : ""}---\nbody\n`;
  await mkdir(join(home, "skills", name), { recursive: true });
  await writeFile(skillFile(name), text);
  if (opts.record === false) return;
  const ledger = new Ledger(home, { now: () => opts.at ?? daysAgo(60) });
  await ledger.record({ actor: opts.actor ?? "agent", kind: "skill", path: skillFile(name), action: "create", summary: `create ${name}`, before: null, after: text });
}

test("archives stale agent-made skills and leaves the rest", async () => {
  await makeSkill("stale");
  await makeSkill("reviewed", { actor: "review" });
  await makeSkill("fresh", { at: daysAgo(5) });
  await makeSkill("used");
  await recordSkillUse(home, "used", daysAgo(3));
  await makeSkill("pinned", { pinned: true });
  await makeSkill("by-user", { actor: "user" });
  await makeSkill("hand-written", { record: false });
  await makeSkill("adopted");
  await new Ledger(home, { now: () => daysAgo(50) }).record({
    actor: "user",
    kind: "skill",
    path: skillFile("adopted"),
    action: "patch",
    summary: "patch",
    before: "a",
    after: "b",
  });

  const ledger = new Ledger(home);
  const result = await runCurator(home, { ledger, now: NOW });
  expect(result).toEqual({ archived: ["reviewed", "stale"], ran: true });
  expect((await readdir(join(home, "skills", ".archive"))).sort()).toEqual(["reviewed-2026-10-14", "stale-2026-10-14"]);
  expect(await readFile(join(home, "skills", ".archive", "stale-2026-10-14", "SKILL.md"), "utf8")).toContain("description: stale");
  for (const kept of ["fresh", "used", "pinned", "by-user", "hand-written", "adopted"]) expect(existsSync(skillFile(kept))).toBe(true);
  expect(JSON.parse(await readFile(join(home, "learning", "curator.json"), "utf8"))).toEqual({ lastRun: NOW.toISOString() });
});

test("runs at most every 7 days", async () => {
  const ledger = new Ledger(home);
  expect((await runCurator(home, { ledger, now: daysAgo(6) })).ran).toBe(true);
  await makeSkill("stale");
  expect(await runCurator(home, { ledger, now: NOW })).toEqual({ archived: [], ran: false });
  expect(existsSync(skillFile("stale"))).toBe(true);
  expect(await runCurator(home, { ledger, now: daysAgo(-1) })).toEqual({ archived: ["stale"], ran: true });
  // A clock that went backwards runs again rather than waiting for years.
  expect((await runCurator(home, { ledger, now: daysAgo(30) })).ran).toBe(true);
});

test("a skill the agent deleted and the user re-created is the user's", async () => {
  await makeSkill("redo");
  const ledger = new Ledger(home, { now: () => daysAgo(40) });
  await ledger.record({ actor: "agent", kind: "skill", path: skillFile("redo"), action: "delete", summary: "d", before: "x", after: null });
  // The user then writes their own skill with that name: no longer the agent's.
  expect((await runCurator(home, { ledger, now: NOW })).archived).toEqual([]);
  expect(existsSync(skillFile("redo"))).toBe(true);
});

test("an undone creation no longer counts as the agent's", async () => {
  await makeSkill("temp");
  const ledger = new Ledger(home);
  expect((await ledger.undo()).ok).toBe(true);
  // The user recreates it by hand.
  await mkdir(join(home, "skills", "temp"), { recursive: true });
  await writeFile(skillFile("temp"), "---\ndescription: mine\n---\n");
  expect((await runCurator(home, { ledger, now: NOW })).archived).toEqual([]);
  expect(existsSync(skillFile("temp"))).toBe(true);
});

test("symlinked, unreadable and missing skills are left alone; names don't collide in the archive", async () => {
  await writeFile(join(outside, "SKILL.md"), "---\ndescription: x\n---\n");
  await mkdir(join(home, "skills"), { recursive: true });
  await symlink(outside, join(home, "skills", "linked"));
  const ledger = new Ledger(home, { now: () => daysAgo(60) });
  await ledger.record({ actor: "agent", kind: "skill", path: join(home, "skills", "linked", "SKILL.md"), action: "create", summary: "c", before: null, after: "x" });
  await ledger.record({ actor: "agent", kind: "skill", path: skillFile("missing"), action: "create", summary: "c", before: null, after: "x" });
  await ledger.record({ actor: "agent", kind: "skill", path: join(home, "skills", ".archive", "x", "SKILL.md"), action: "create", summary: "c", before: null, after: "x" });
  await ledger.record({ actor: "agent", kind: "skill", path: join(home, "elsewhere", "SKILL.md"), action: "create", summary: "c", before: null, after: "x" });
  await ledger.record({ actor: "agent", kind: "memory", path: skillFile("mem"), action: "create", summary: "c", before: null, after: "x" });
  await mkdir(join(home, "skills", "nofile"), { recursive: true });
  await ledger.record({ actor: "agent", kind: "skill", path: skillFile("nofile"), action: "create", summary: "c", before: null, after: "x" });
  await makeSkill("twice");
  await mkdir(join(home, "skills", ".archive", "twice-2026-10-14"), { recursive: true });

  const result = await runCurator(home, { ledger: new Ledger(home), now: NOW });
  expect(result.archived).toEqual(["twice"]);
  expect(existsSync(join(home, "skills", ".archive", "twice-2026-10-14-2", "SKILL.md"))).toBe(true);
  expect(existsSync(join(outside, "SKILL.md"))).toBe(true);
  expect(existsSync(join(home, "skills", "nofile"))).toBe(true);
});

test("a custom skills folder and a corrupt state file", async () => {
  await mkdir(join(home, "learning"), { recursive: true });
  await writeFile(join(home, "learning", "curator.json"), "{bad");
  const custom = join(home, "custom");
  const text = "---\ndescription: old\n---\n";
  await mkdir(join(custom, "old"), { recursive: true });
  await writeFile(join(custom, "old", "SKILL.md"), text);
  const ledger = new Ledger(home, { now: () => daysAgo(31) });
  await ledger.record({ actor: "review", kind: "skill", path: join(custom, "old", "SKILL.md"), action: "create", summary: "c", before: null, after: text });
  expect(await runCurator(home, { ledger, now: NOW, skillsDir: custom })).toEqual({ archived: ["old"], ran: true });
  expect(existsSync(join(custom, ".archive", "old-2026-10-14", "SKILL.md"))).toBe(true);
});

test("a failed move leaves the skill and the run still completes", async () => {
  await makeSkill("stuck");
  await mkdir(join(home, "skills"), { recursive: true });
  await writeFile(join(home, "skills", ".archive"), "a file where the archive folder should be");
  expect(await runCurator(home, { ledger: new Ledger(home), now: NOW })).toEqual({ archived: [], ran: true });
  expect(existsSync(skillFile("stuck"))).toBe(true);
});

test("the learned-skills folder: archives there, still reads usage from skills/.usage.json", async () => {
  const learned = join(home, "skills-learned");
  const ledger = new Ledger(home, { now: () => daysAgo(60) });
  for (const name of ["idle", "busy"]) {
    const text = `---\ndescription: ${name}\n---\n`;
    await mkdir(join(learned, name), { recursive: true });
    await writeFile(join(learned, name, "SKILL.md"), text);
    await ledger.record({ actor: "review", kind: "skill", path: join(learned, name, "SKILL.md"), action: "create", summary: "c", before: null, after: text });
  }
  // A same-named skill in the user's own folder is not the curator's business.
  await makeSkill("idle", { record: false });
  await recordSkillUse(home, "busy", daysAgo(2));
  expect(await runCurator(home, { ledger, now: NOW, skillsDir: learned })).toEqual({ archived: ["idle"], ran: true });
  expect(existsSync(join(learned, ".archive", "idle-2026-10-14", "SKILL.md"))).toBe(true);
  expect(existsSync(join(learned, "busy", "SKILL.md"))).toBe(true);
  expect(existsSync(skillFile("idle"))).toBe(true);
  expect(existsSync(join(home, "skills", ".archive"))).toBe(false);
});

test("a skill edited by hand since the ledger last saw it is never archived", async () => {
  await makeSkill("edited");
  await writeFile(skillFile("edited"), "---\ndescription: edited\n---\nmy own steps\n");
  // Patched by the agent since: the ledger's last text is what counts.
  await makeSkill("patched");
  const patched = "---\ndescription: patched\n---\nv2\n";
  await new Ledger(home, { now: () => daysAgo(45) }).record({ actor: "agent", kind: "skill", path: skillFile("patched"), action: "patch", summary: "p", before: "x", after: patched });
  await writeFile(skillFile("patched"), patched);
  // A patch the user undid: the file is back to what the creation wrote.
  await makeSkill("reverted");
  const original = await readFile(skillFile("reverted"), "utf8");
  const undoLedger = new Ledger(home, { now: () => daysAgo(45) });
  await undoLedger.record({ actor: "agent", kind: "skill", path: skillFile("reverted"), action: "patch", summary: "p", before: original, after: "v2" });
  await writeFile(skillFile("reverted"), "v2");
  expect((await undoLedger.undo()).ok).toBe(true);
  expect(await readFile(skillFile("reverted"), "utf8")).toBe(original);
  // Only a supporting file was ever recorded: nothing to compare SKILL.md with, so it stays.
  await mkdir(join(home, "skills", "unknown"), { recursive: true });
  await writeFile(skillFile("unknown"), "---\ndescription: unknown\n---\n");
  await new Ledger(home, { now: () => daysAgo(60) }).record({ actor: "agent", kind: "skill", path: join(home, "skills", "unknown", "notes.md"), action: "create", summary: "c", before: null, after: "n" });

  const result = await runCurator(home, { ledger: new Ledger(home), now: NOW });
  expect(result.archived).toEqual(["patched", "reverted"]);
  expect(existsSync(skillFile("edited"))).toBe(true);
  expect(existsSync(skillFile("unknown"))).toBe(true);
});
