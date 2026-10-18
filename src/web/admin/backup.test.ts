import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backupHandlers } from "./backup";
import { adminOverWs, makeKit, writeText, type Kit } from "./ops-testkit";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
  await writeText(join(kit.home, "settings.json"), '{"model":"claude-sonnet-5-5"}\n');
  await writeText(join(kit.home, "credentials.json"), '{"anthropic":"sk-secret"}\n');
  await writeText(join(kit.home, "projects", "p", "s.jsonl"), '{"type":"meta"}\n');
});
afterEach(() => kit.cleanup());

test("create writes a verified archive in <home>/backups and list shows it", async () => {
  const h = backupHandlers(kit.ctx);
  const made = await h["backup.create"]!(undefined);
  expect(made.path.startsWith(join(kit.home, "backups"))).toBe(true);
  expect(made).toMatchObject({ secrets: true, sessions: true });
  expect(made.size).toBeGreaterThan(0);
  expect(await h["backup.list"]!(undefined)).toEqual([made]);
});

test("create honours quick/sessions/secrets", async () => {
  const h = backupHandlers(kit.ctx);
  const made = await h["backup.create"]!({ sessions: false, secrets: false });
  expect(made).toMatchObject({ secrets: false, sessions: false });
});

test("list also shows Tropos archives in the user's home, but not other files", async () => {
  const h = backupHandlers(kit.ctx);
  const made = await h["backup.create"]!(undefined);
  await writeFile(join(kit.userHome, "tropos-backup-2020-01-01T00-00-00Z.tar.gz"), "not an archive");
  await writeFile(join(kit.userHome, "holiday-photos.tar.gz"), "mine");
  const names = (await h["backup.list"]!(undefined)).map((b) => b.name);
  expect(names).toContain(made.name);
  expect(names).toContain("tropos-backup-2020-01-01T00-00-00Z.tar.gz");
  expect(names).not.toContain("holiday-photos.tar.gz");
});

test("verify reports ok, and the problems of a damaged archive", async () => {
  const h = backupHandlers(kit.ctx);
  const made = await h["backup.create"]!(undefined);
  expect(await h["backup.verify"]!({ name: made.name })).toEqual({ ok: true, problems: [] });
  await writeFile(made.path, "garbage");
  const bad = await h["backup.verify"]!({ name: made.name });
  expect(bad.ok).toBe(false);
  expect(bad.problems.length).toBeGreaterThan(0);
});

test("names must be plain file names", async () => {
  const h = backupHandlers(kit.ctx);
  for (const name of ["../settings.json", "a/b.tar.gz", "..\\x.tar.gz", "/etc/passwd", "x.tar.gz\0", ""]) {
    await expect(h["backup.verify"]!({ name })).rejects.toThrow();
    await expect(h["backup.restore"]!({ name })).rejects.toThrow();
    await expect(h["backup.delete"]!({ name })).rejects.toThrow();
  }
  await expect(h["backup.delete"]!({ name: "settings.json" })).rejects.toThrow(/No backup named/);
  expect(existsSync(join(kit.home, "settings.json"))).toBe(true);
});

test("restore with dryRun reports the files and writes nothing", async () => {
  const h = backupHandlers(kit.ctx);
  const made = await h["backup.create"]!(undefined);
  await writeFile(join(kit.home, "settings.json"), '{"model":"changed"}\n');
  const r = await h["backup.restore"]!({ name: made.name, dryRun: true });
  expect(r.restored).toContain("settings.json");
  expect(r.safetyBackup).toBeUndefined();
  expect(await readFile(join(kit.home, "settings.json"), "utf8")).toContain("changed");
  expect(await h["backup.list"]!(undefined)).toHaveLength(1);
});

test("restore puts the files back after a safety backup of the current state", async () => {
  const h = backupHandlers(kit.ctx);
  const made = await h["backup.create"]!(undefined);
  await writeFile(join(kit.home, "settings.json"), '{"model":"changed"}\n');
  kit.clock.now += 60_000; // a different archive name from the first
  let reloaded = 0;
  const withGateway = backupHandlers({ ...kit.ctx, gateway: { runCronNow: async () => {}, reload: async () => void reloaded++, devicesChanged: async () => {} } });
  const r = await withGateway["backup.restore"]!({ name: made.name });
  expect(await readFile(join(kit.home, "settings.json"), "utf8")).toContain("claude-sonnet-5-5");
  expect(r.safetyBackup).toBeDefined();
  expect(existsSync(r.safetyBackup!)).toBe(true);
  expect(reloaded).toBe(1);
  expect((await h["backup.list"]!(undefined)).length).toBe(2);
});

test("delete removes a Tropos archive only", async () => {
  const h = backupHandlers(kit.ctx);
  const made = await h["backup.create"]!(undefined);
  expect(await h["backup.delete"]!({ name: made.name })).toEqual({ removed: true });
  expect(existsSync(made.path)).toBe(false);
  // Right name and place, not an archive: refused and kept.
  const fake = join(kit.home, "backups", "tropos-notes.tar.gz");
  await writeFile(fake, "my notes");
  await expect(h["backup.delete"]!({ name: "tropos-notes.tar.gz" })).rejects.toThrow(/not a Tropos backup/);
  expect(existsSync(fake)).toBe(true);
});

test("a symlink in the backup directory is not followed", async () => {
  const h = backupHandlers(kit.ctx);
  await h["backup.create"]!(undefined);
  await symlink(join(kit.home, "settings.json"), join(kit.home, "backups", "tropos-link.tar.gz"));
  await expect(h["backup.delete"]!({ name: "tropos-link.tar.gz" })).rejects.toThrow(/No backup named/);
  expect(existsSync(join(kit.home, "settings.json"))).toBe(true);
});

test("create refuses an empty home with the library's message", async () => {
  const empty = await makeKit();
  try {
    await expect(backupHandlers(empty.ctx)["backup.create"]!(undefined)).rejects.toThrow(/Nothing to back up/);
  } finally {
    await empty.cleanup();
  }
});

test("injected library calls: a second operation while one runs is refused", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = backupHandlers(kit.ctx, { create: (async () => (await gate, { dryRun: false, fileCount: 0, totalBytes: 0, skipped: [], files: [] })) as never });
  const first = h["backup.create"]!(undefined).catch((e: Error) => e);
  await expect(h["backup.create"]!(undefined)).rejects.toThrow(/Another backup operation/);
  release();
  expect(await first).toBeInstanceOf(Error); // no archive path came back
});

test("end to end over the WebSocket: create, list, verify, restore dry run, delete", async () => {
  const ws = await adminOverWs(kit.ctx, backupHandlers(kit.ctx));
  try {
    const made = await ws.call("backup.create", { quick: true });
    expect(made.ok).toBe(true);
    const { name } = made.result as { name: string };
    expect(await ws.call("backup.list")).toMatchObject({ ok: true, result: [{ name }] });
    expect(await ws.call("backup.verify", { name })).toMatchObject({ ok: true, result: { ok: true } });
    expect(await ws.call("backup.restore", { name, dryRun: true })).toMatchObject({ ok: true });
    expect(await ws.call("backup.delete", { name: "../x.tar.gz" })).toMatchObject({ ok: false });
    expect(await ws.call("backup.delete", { name })).toMatchObject({ ok: true, result: { removed: true } });
  } finally {
    await ws.close();
  }
});

test("restore: a backup with files that run code is refused without trustCode, and the dry run lists them", async () => {
  await writeText(join(kit.home, "skills", "s", "SKILL.md"), "do things\n");
  const h = backupHandlers(kit.ctx);
  const made = await h["backup.create"]!(undefined);
  await writeText(join(kit.home, "skills", "s", "SKILL.md"), "changed\n");
  kit.clock.now += 60_000;

  const dry = await h["backup.restore"]!({ name: made.name, dryRun: true });
  expect(dry.risky.map((r) => r.path)).toEqual(["skills/s/SKILL.md"]);
  expect(dry.risky[0]!.why).toBeTruthy();

  await expect(h["backup.restore"]!({ name: made.name })).rejects.toThrow(/skills\/s\/SKILL\.md/);
  await expect(h["backup.restore"]!({ name: made.name, trustCode: false })).rejects.toThrow(/can run code/);
  expect(await readFile(join(kit.home, "skills", "s", "SKILL.md"), "utf8")).toBe("changed\n");

  const done = await h["backup.restore"]!({ name: made.name, trustCode: true });
  expect(done.risky.map((r) => r.path)).toEqual(["skills/s/SKILL.md"]);
  expect(await readFile(join(kit.home, "skills", "s", "SKILL.md"), "utf8")).toBe("do things\n");
});
