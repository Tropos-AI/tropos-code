import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { isLearnedPath, Ledger, type LedgerKind, recordSetupChange, sha256 } from "./ledger";

let home: string;
let outside: string;
let ledger: Ledger;

beforeEach(async () => {
  home = await makeTmpDir();
  outside = await makeTmpDir();
  ledger = new Ledger(home, { now: () => new Date("2026-10-14T12:00:00Z") });
});

afterEach(async () => {
  await removeDir(home);
  await removeDir(outside);
});

const memPath = () => join(home, "workspace", "MEMORY.md");

async function write(path: string, text: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

test("record stores hashes, blobs and an owner-only log", async () => {
  const e = await ledger.record({ actor: "agent", kind: "memory", path: memPath(), action: "add", summary: "add: x", before: null, after: "x\n" });
  expect(e).toMatchObject({ actor: "agent", kind: "memory", ts: "2026-10-14T12:00:00.000Z", before: null, after: sha256("x\n") });
  expect(e.id).toMatch(/^[0-9a-f]{12}$/);
  expect(await readFile(join(home, "learning", "blobs", sha256("x\n")), "utf8")).toBe("x\n");
  expect((await stat(ledger.file)).mode & 0o777).toBe(0o600);
  expect((await stat(ledger.dir)).mode & 0o777).toBe(0o700);
  // Same contents twice: one blob.
  await ledger.record({ actor: "review", kind: "memory", path: memPath(), action: "add", summary: "again", before: "x\n", after: "x\n" });
  expect(await readdir(join(home, "learning", "blobs"))).toEqual([sha256("x\n")]);
});

test("list is newest first, honours limit and skips bad lines", async () => {
  expect(await ledger.list()).toEqual([]);
  for (const s of ["a", "b", "c"]) {
    await ledger.record({ actor: "agent", kind: "user", path: memPath(), action: "add", summary: s, before: null, after: s });
  }
  await appendFile(ledger.file, "not json\n{\"id\":1}\n\n");
  expect((await ledger.list()).map((e) => e.summary)).toEqual(["c", "b", "a"]);
  expect((await ledger.list(2)).map((e) => e.summary)).toEqual(["c", "b"]);
  expect(await ledger.list(-1)).toEqual([]);
});

test("undo restores the previous contents and records itself", async () => {
  await write(memPath(), "old\n");
  const e = await ledger.record({ actor: "review", kind: "memory", path: memPath(), action: "replace", summary: "replace: new", before: "old\n", after: "new\n" });
  await writeFile(memPath(), "new\n");
  const res = await ledger.undo();
  expect(res).toEqual({ ok: true, entry: { ...e, undone: true } });
  expect(await readFile(memPath(), "utf8")).toBe("old\n");
  const [undo, original] = await ledger.list();
  expect(undo).toMatchObject({ action: "undo", actor: "user", undoes: e.id, before: sha256("new\n"), after: sha256("old\n"), summary: "undo replace: replace: new" });
  expect(original).toMatchObject({ id: e.id, undone: true });
  expect(await ledger.undo()).toEqual({ ok: false, reason: "Nothing to undo." });
  expect(await ledger.undo(e.id)).toEqual({ ok: false, reason: `${e.id} was already undone.` });
  expect(await ledger.undo(undo!.id)).toEqual({ ok: false, reason: `${undo!.id} is itself an undo.` });
  expect(await ledger.undo("nope")).toEqual({ ok: false, reason: "No ledger entry nope." });
});

test("default undo walks back through history, newest first", async () => {
  await write(memPath(), "");
  await ledger.record({ actor: "agent", kind: "memory", path: memPath(), action: "add", summary: "1", before: "", after: "a\n" });
  await ledger.record({ actor: "agent", kind: "memory", path: memPath(), action: "add", summary: "2", before: "a\n", after: "a\nb\n" });
  await writeFile(memPath(), "a\nb\n");
  expect((await ledger.undo()).ok).toBe(true);
  expect(await readFile(memPath(), "utf8")).toBe("a\n");
  expect((await ledger.undo()).ok).toBe(true);
  expect(await readFile(memPath(), "utf8")).toBe("");
});

test("undo refuses when the file changed since", async () => {
  await write(memPath(), "hand edited\n");
  const e = await ledger.record({ actor: "agent", kind: "memory", path: memPath(), action: "add", summary: "s", before: null, after: "x\n" });
  const res = await ledger.undo(e.id);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("changed since");
  expect(await readFile(memPath(), "utf8")).toBe("hand edited\n");
});

test("undo of a created skill removes SKILL.md and its empty folder", async () => {
  const path = join(home, "skills", "release", "SKILL.md");
  await write(path, "skill");
  await ledger.record({ actor: "agent", kind: "skill", path, action: "create", summary: "create release", before: null, after: "skill" });
  expect((await ledger.undo()).ok).toBe(true);
  expect(existsSync(join(home, "skills", "release"))).toBe(false);
  expect(existsSync(join(home, "skills"))).toBe(true);
});

test("undo of a created file when the file is already gone just records the undo", async () => {
  const path = join(home, "memories", "USER.md");
  await ledger.record({ actor: "agent", kind: "user", path, action: "x", summary: "s", before: null, after: null });
  expect((await ledger.undo()).ok).toBe(true);
  expect(existsSync(path)).toBe(false);
});

test("undo of a delete restores the file, recreating folders", async () => {
  const path = join(home, "skills", "gone", "SKILL.md");
  await ledger.record({ actor: "agent", kind: "skill", path, action: "delete", summary: "delete gone", before: "body", after: null });
  expect((await ledger.undo()).ok).toBe(true);
  expect(await readFile(path, "utf8")).toBe("body");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("undo refuses paths outside the home, through symlinks, or that aren't files", async () => {
  const far = join(outside, "x.md");
  await writeFile(far, "a");
  const e1 = await ledger.record({ actor: "agent", kind: "memory", path: far, action: "add", summary: "s", before: null, after: "a" });
  const res = await ledger.undo(e1.id);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("outside");
  expect(await readFile(far, "utf8")).toBe("a");

  await mkdir(join(home, "skills"), { recursive: true });
  await symlink(outside, join(home, "skills", "linked"));
  const viaLink = join(home, "skills", "linked", "x", "SKILL.md");
  await mkdir(join(outside, "x"));
  await writeFile(join(outside, "x", "SKILL.md"), "a");
  const e2 = await ledger.record({ actor: "agent", kind: "skill", path: viaLink, action: "patch", summary: "s", before: "b", after: "a" });
  const res2 = await ledger.undo(e2.id);
  expect(res2.ok).toBe(false);
  if (!res2.ok) expect(res2.reason).toContain("resolves outside");
  expect(await readFile(join(outside, "x", "SKILL.md"), "utf8")).toBe("a");
  // Nor does the default undo pick any of them.
  expect((await ledger.undo()).ok).toBe(false);

  const dirPath = join(home, "memories", "MEMORY.md");
  await mkdir(dirPath, { recursive: true });
  const e3 = await ledger.record({ actor: "agent", kind: "memory", path: dirPath, action: "add", summary: "s", before: null, after: "a" });
  expect(await ledger.undo(e3.id)).toEqual({ ok: false, reason: `${dirPath} is not a regular file.` });
});

test("a corrupt blob fails the undo without touching the file", async () => {
  await write(memPath(), "new");
  const e = await ledger.record({ actor: "agent", kind: "memory", path: memPath(), action: "replace", summary: "s", before: "old", after: "new" });
  await writeFile(join(home, "learning", "blobs", e.before!), "tampered");
  await expect(ledger.undo(e.id)).rejects.toThrow("corrupt");
  expect(await readFile(memPath(), "utf8")).toBe("new");
  // The queue keeps working after a failure.
  expect((await ledger.list()).length).toBe(1);
});

test("parallel records are all kept", async () => {
  const fresh = new Ledger(home);
  await Promise.all(["a", "b", "c", "d"].map((s) => fresh.record({ actor: "agent", kind: "daily", path: memPath(), action: "append", summary: s, before: null, after: s })));
  expect((await fresh.list()).map((e) => e.summary).sort()).toEqual(["a", "b", "c", "d"]);
  expect(Date.parse((await fresh.list())[0]!.ts)).not.toBeNaN();
});

test("journal days are learned paths", () => {
  expect(isLearnedPath(home, "daily", join(home, "workspace", "memory", "2026-10-16.md"))).toBe(true);
  expect(isLearnedPath(home, "daily", join(home, "workspace", "memory", "notes.md"))).toBe(false);
  expect(isLearnedPath(home, "daily", join(home, "workspace", "other", "2026-10-16.md"))).toBe(false);
});

test("isLearnedPath allows only the files each kind writes, under the home", () => {
  const ok: Array<[LedgerKind, string]> = [
    ["memory", "memories/MEMORY.md"],
    ["memory", "memories/USER.md"],
    ["user", "memories/USER.md"],
    ["skill", "skills/release/SKILL.md"],
    ["skill", "skills/release/scripts/run.sh"],
    ["skill", "skills-learned/release/SKILL.md"],
    ["identity", "IDENTITY.md"],
    ["identity", "SOUL.md"],
    ["daily", "projects/-Users-me-app-0123456789ab/notes/2026-10-14.md"],
    ["agent", "agents/reviewer/AGENT.md"],
    ["agent", "agents/reviewer.md"],
    ["memory", "agents/reviewer/MEMORY.md"],
    ["daily", "agents/reviewer/memory/2026-10-16.md"],
    ["skill", "agents/reviewer/skills/lint/SKILL.md"],
  ];
  for (const [kind, rel] of ok) expect({ kind, rel, ok: isLearnedPath(home, kind, join(home, rel)) }).toEqual({ kind, rel, ok: true });
  const no: Array<[LedgerKind, string]> = [
    ["memory", "memories/OTHER.md"],
    ["memory", "MEMORY.md"],
    ["user", "memories/x/USER.md"],
    ["memory", "settings.json"],
    ["identity", "memories/MEMORY.md"],
    ["identity", "sub/SOUL.md"],
    ["skill", "skills/SKILL.md"],
    ["skill", "skills/.archive/old/SKILL.md"],
    ["skill", "plugins/x/SKILL.md"],
    ["daily", "projects/p/notes/today.md"],
    ["daily", "projects/p/notes/2026-10-14.txt"],
    ["daily", "projects/p/other/2026-10-14.md"],
    ["daily", "notes/2026-10-14.md"],
    ["memory", "memories/../settings.json"],
    ["skill", "skills/../../escape/x/SKILL.md"],
    ["identity", ""],
    ["identity", "../SOUL.md"],
    ["agent", "agents/.archive/x/AGENT.md"],
    ["agent", "agents/reviewer/revisions/1.md"],
    ["agent", "agents/reviewer/skills/AGENT.md"],
    ["memory", "agents/.archive/MEMORY.md"],
    ["user", "agents/reviewer/MEMORY.md"],
    ["skill", "agents/reviewer/skills/SKILL.md"],
    ["skill", "agents/reviewer/skills/.archive/x/SKILL.md"],
    ["daily", "agents/reviewer/memory/today.md"],
  ];
  for (const [kind, rel] of no) expect({ kind, rel, ok: isLearnedPath(home, kind, join(home, rel)) }).toEqual({ kind, rel, ok: false });
  expect(isLearnedPath(home, "memory", join(outside, "memories", "MEMORY.md"))).toBe(false);
  expect(isLearnedPath(home, "other" as LedgerKind, join(home, "memories", "MEMORY.md"))).toBe(false);
  // A relative home resolves like any path.
  expect(isLearnedPath("rel-home", "identity", "rel-home/SOUL.md")).toBe(true);
});

test("undo refuses a file that isn't a learned file of the entry's kind", async () => {
  const settings = join(home, "settings.json");
  await writeFile(settings, "{}");
  const e = await ledger.record({ actor: "agent", kind: "memory", path: settings, action: "add", summary: "s", before: "evil", after: "{}" });
  expect(await ledger.undo(e.id)).toEqual({ ok: false, reason: `${settings} is not a learned file; refusing to touch it.` });
  const sneaky = join(home, "memories", "..", "settings.json");
  const e2 = await ledger.record({ actor: "agent", kind: "memory", path: sneaky, action: "add", summary: "s", before: "evil", after: "{}" });
  expect(await ledger.undo(e2.id)).toEqual({ ok: false, reason: `${sneaky} is not a learned file; refusing to touch it.` });
  const wrongKind = await ledger.record({ actor: "agent", kind: "identity", path: memPath(), action: "add", summary: "s", before: "evil", after: null });
  expect((await ledger.undo(wrongKind.id)).ok).toBe(false);
  expect(await ledger.undo()).toMatchObject({ ok: false });
  expect(await readFile(settings, "utf8")).toBe("{}");
  expect(existsSync(memPath())).toBe(false);
});

test("undo of a created skill under skills-learned removes it and its folder, never the root", async () => {
  const path = join(home, "skills-learned", "deploy", "SKILL.md");
  await write(path, "skill");
  await ledger.record({ actor: "review", kind: "skill", path, action: "create", summary: "create deploy", before: null, after: "skill" });
  expect((await ledger.undo()).ok).toBe(true);
  expect(existsSync(join(home, "skills-learned", "deploy"))).toBe(false);
  expect(existsSync(join(home, "skills-learned"))).toBe(true);
  // A supporting file's folder stays: only a SKILL.md takes its skill folder with it.
  const support = join(home, "skills-learned", "deploy", "scripts", "SKILL.md");
  await write(support, "x");
  await ledger.record({ actor: "review", kind: "skill", path: support, action: "write_file", summary: "w", before: null, after: "x" });
  expect((await ledger.undo()).ok).toBe(true);
  expect(existsSync(join(home, "skills-learned", "deploy", "scripts"))).toBe(true);
});

test("default undo skips stuck entries and takes the newest one that still matches its file", async () => {
  await write(memPath(), "a\n");
  const good = await ledger.record({ actor: "agent", kind: "memory", path: memPath(), action: "add", summary: "good", before: "", after: "a\n" });
  // The curator moved this skill away since.
  await ledger.record({ actor: "agent", kind: "skill", path: join(home, "skills", "moved", "SKILL.md"), action: "create", summary: "moved", before: null, after: "s" });
  // Recorded, but the write failed: the file still holds the old text.
  await write(join(home, "SOUL.md"), "old soul");
  await ledger.record({ actor: "agent", kind: "identity", path: join(home, "SOUL.md"), action: "write", summary: "failed", before: "old soul", after: "new soul" });
  // The user edited this one by hand.
  const user = join(home, "memories", "USER.md");
  await write(user, "hand edit");
  await ledger.record({ actor: "agent", kind: "user", path: user, action: "add", summary: "edited", before: null, after: "agent text" });
  // A path whose parent is a file can't be read at all.
  await write(join(home, "projects", "p", "notes"), "a file, not a folder");
  await ledger.record({ actor: "agent", kind: "daily", path: join(home, "projects", "p", "notes", "2026-10-14.md"), action: "append", summary: "x", before: null, after: "x" });

  const res = await ledger.undo();
  expect(res).toMatchObject({ ok: true, entry: { id: good.id, undone: true } });
  expect(await readFile(memPath(), "utf8")).toBe("");
  expect(await readFile(join(home, "SOUL.md"), "utf8")).toBe("old soul");
  expect(await readFile(user, "utf8")).toBe("hand edit");
  expect(await ledger.undo()).toEqual({
    ok: false,
    reason: "Nothing to undo: every learned change left was edited, moved or never written since. Undo one by id to see why.",
  });
});

test("workspace skill files are learned paths; .archive is not", () => {
  const skill = (...parts: string[]) => isLearnedPath(home, "skill", join(home, ...parts));
  expect(skill("workspace", "skills-learned", "x", "SKILL.md")).toBe(true);
  expect(skill("workspace", "skills", "x", "ref", "a.md")).toBe(true);
  expect(skill("workspace", "skills-learned", ".archive", "x", "SKILL.md")).toBe(false);
  expect(skill("workspace", "skills", "SKILL.md")).toBe(false);
  expect(skill("workspace", "other", "x", "SKILL.md")).toBe(false);
  expect(skill("skills-learned", "x", "SKILL.md")).toBe(true); // LEGACY_LAYOUT
});

test("workspace memory and identity files are learned paths", () => {
  expect(isLearnedPath(home, "user", join(home, "workspace", "USER.md"))).toBe(true);
  expect(isLearnedPath(home, "memory", join(home, "workspace", "MEMORY.md"))).toBe(true);
  // Lessons live in the workspace AGENTS.md under the memory kind; the user kind never writes it.
  expect(isLearnedPath(home, "memory", join(home, "workspace", "AGENTS.md"))).toBe(true);
  expect(isLearnedPath(home, "user", join(home, "workspace", "AGENTS.md"))).toBe(false);
  expect(isLearnedPath(home, "memory", join(home, "memories", "AGENTS.md"))).toBe(false);
  expect(isLearnedPath(home, "identity", join(home, "workspace", "SOUL.md"))).toBe(true);
  expect(isLearnedPath(home, "memory", join(home, "workspace", "README.md"))).toBe(false);
  expect(isLearnedPath(home, "identity", join(home, "workspace", "sub", "SOUL.md"))).toBe(false);
  // LEGACY_LAYOUT: the old places stay accepted.
  expect(isLearnedPath(home, "user", join(home, "memories", "USER.md"))).toBe(true);
  expect(isLearnedPath(home, "identity", join(home, "IDENTITY.md"))).toBe(true);
});

test("undo of a change recorded before the move restores the moved file", async () => {
  const old = join(home, "memories", "USER.md");
  const e = await ledger.record({ actor: "agent", kind: "user", path: old, action: "add", summary: "add: b", before: "a\n", after: "a\n§\nb\n" });
  await write(old, "a\n§\nb\n");
  await mkdir(join(home, "workspace"), { recursive: true });
  await rename(old, join(home, "workspace", "USER.md"));
  expect(await ledger.undo(e.id)).toMatchObject({ ok: true });
  expect(await readFile(join(home, "workspace", "USER.md"), "utf8")).toBe("a\n");
  expect(existsSync(old)).toBe(false);
});

test("an id-less undo also follows a moved file, and still refuses an edited one", async () => {
  const old = join(home, "SOUL.md");
  await ledger.record({ actor: "agent", kind: "identity", path: old, action: "soul", summary: "s", before: "x\n", after: "y\n" });
  await write(join(home, "workspace", "SOUL.md"), "edited by hand\n");
  expect(await ledger.undo()).toMatchObject({ ok: false });
  await write(join(home, "workspace", "SOUL.md"), "y\n");
  expect(await ledger.undo()).toMatchObject({ ok: true });
  expect(await readFile(join(home, "workspace", "SOUL.md"), "utf8")).toBe("x\n");
});

test("undoing a created specialist file drops its empty folder, never one with other files", async () => {
  const empty = join(home, "agents", "a", "AGENT.md");
  await write(empty, "x");
  const e = await ledger.record({ actor: "agent", kind: "agent", path: empty, action: "create", summary: "s", before: null, after: "x" });
  expect((await ledger.undo(e.id)).ok).toBe(true);
  expect(existsSync(join(home, "agents", "a"))).toBe(false);
  expect(existsSync(join(home, "agents"))).toBe(true);
  const busy = join(home, "agents", "b", "AGENT.md");
  await write(busy, "x");
  await write(join(home, "agents", "b", "MEMORY.md"), "keep");
  const e2 = await ledger.record({ actor: "agent", kind: "agent", path: busy, action: "create", summary: "s", before: null, after: "x" });
  expect((await ledger.undo(e2.id)).ok).toBe(true);
  expect(await readFile(join(home, "agents", "b", "MEMORY.md"), "utf8")).toBe("keep");
});

test("a specialist's own skill folder is dropped on undo like any skill folder", async () => {
  const path = join(home, "agents", "a", "skills", "lint", "SKILL.md");
  await write(path, "x");
  const e = await ledger.record({ actor: "agent", kind: "skill", path, action: "create", summary: "s", before: null, after: "x" });
  expect((await ledger.undo(e.id)).ok).toBe(true);
  expect(existsSync(join(home, "agents", "a", "skills", "lint"))).toBe(false);
  expect(existsSync(join(home, "agents", "a", "skills"))).toBe(true);
});

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";

test("only settings.json and gateway.json count as setup files", () => {
  expect(isLearnedPath(home, "setup", join(home, "settings.json"))).toBe(true);
  expect(isLearnedPath(home, "setup", join(home, "gateway.json"))).toBe(true);
  expect(isLearnedPath(home, "setup", join(home, "workspace", "MEMORY.md"))).toBe(false);
  expect(isLearnedPath(home, "setup", join(home, "gateway", "pairing.json"))).toBe(false);
});

test("a setup change undoes at value level and refuses once the value moved on", async () => {
  await writeFile(join(home, "gateway.json"), JSON.stringify({ proactive: { enabled: false } }));
  const e = await recordSetupChange(ledger, { actor: "agent", path: join(home, "gateway.json"), configPath: "proactive.enabled", action: "proactive.set", summary: "proactive off", before: true, after: false });
  expect((await ledger.undo(e.id)).ok).toBe(true);
  expect(JSON.parse(await readFile(join(home, "gateway.json"), "utf8")).proactive.enabled).toBe(true);
  const e2 = await recordSetupChange(ledger, { actor: "agent", path: join(home, "gateway.json"), configPath: "proactive.enabled", action: "x", summary: "x", before: true, after: false });
  expect(await ledger.undo(e2.id)).toEqual({ ok: false, reason: "It changed since; nothing was undone." });
});

test("undoing a setup change that added a key removes it, and the bare /learned undo skips what it can't apply", async () => {
  await writeFile(join(home, "settings.json"), JSON.stringify({ theme: "dark", mcpServers: { gh: { command: "x" } } }));
  const added = await recordSetupChange(ledger, { actor: "agent", path: join(home, "settings.json"), configPath: "mcpServers.gh", action: "mcp.add", summary: "added gh", before: undefined, after: { command: "x" } });
  await recordSetupChange(ledger, { actor: "agent", path: join(home, "gateway.json"), action: "autonomy.lower", summary: "autonomy ask", noUndo: "no" });
  const out = await ledger.undo();
  expect(out).toMatchObject({ ok: true, entry: { id: added.id } });
  expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ theme: "dark", mcpServers: {} });
});

test("secrets never reach the blobs, and such a change cannot be undone", async () => {
  await recordSetupChange(ledger, { actor: "agent", path: join(home, "gateway.json"), configPath: "telegram", action: "telegram.connect", summary: "Telegram connected", before: {}, after: { botToken: TOKEN } });
  for (const f of await readdir(join(home, "learning", "blobs"))) expect(await readFile(join(home, "learning", "blobs", f), "utf8")).not.toContain(TOKEN);
  const removed = await recordSetupChange(ledger, { actor: "agent", path: join(home, "settings.json"), configPath: "mcpServers.gh", action: "mcp.remove", summary: "x", before: { command: "x", env: { T: "v" } }, after: null });
  expect(removed.noUndo).toContain("secret");
  expect(await ledger.undo(removed.id)).toEqual({ ok: false, reason: removed.noUndo! });
});

test("an entry recorded noUndo refuses with its reason", async () => {
  const e = await recordSetupChange(ledger, { actor: "agent", path: join(home, "gateway.json"), action: "autonomy.lower", summary: "autonomy ask", noUndo: "Raise autonomy in Settings → Autonomy." });
  expect(await ledger.undo(e.id)).toEqual({ ok: false, reason: "Raise autonomy in Settings → Autonomy." });
});
