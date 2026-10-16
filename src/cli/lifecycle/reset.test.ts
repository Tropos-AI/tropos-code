// src/cli/lifecycle/reset.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServiceManager } from "../../service/types";
import { makeFixture, type Fixture } from "./lifecycle-fixture";
import { createReset } from "./reset";

let f: Fixture;
let calls: string[];

const service = (over: { running?: boolean; stopThrows?: boolean } = {}): ServiceManager => ({
  manager: "systemd",
  install: async () => ({ unitPath: "u" }),
  uninstall: async () => ({ removed: true }),
  start: async () => undefined,
  stop: async () => {
    calls.push("stop");
    if (over.stopThrows) throw new Error("systemctl failed");
  },
  restart: async () => undefined,
  status: async () => ({ manager: "systemd", installed: true, running: over.running ?? true }),
});
const run = (argv: string[], over = {}, ctx = f.ctx) => createReset(() => ({ service: service(over) }))(argv, ctx);
const exists = (p: string) => lstat(p).then(() => true, () => false);
const h = (p: string) => join(f.ctx.home, p);

beforeEach(async () => {
  f = await makeFixture();
  calls = [];
  const files: Record<string, string> = {
    "settings.json": "{}",
    "gateway.json": "{}",
    "credentials.json": "{}",
    "gateway/pairing.json": "{}",
    "gateway/sessions.json": "{}",
    "gateway/chats.json": "{}",
    "gateway/cron/jobs.json": "[]",
    "projects/k/s.jsonl": "x",
    "projects/k/settings.json": "{}",
    "memories/m.md": "m",
    "workspace/code.ts": "code",
    "backups/older.tar.gz": "old",
  };
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(h(p)), { recursive: true });
    await writeFile(h(p), c);
  }
});
afterEach(() => f.cleanup());

describe("tcode reset", () => {
  test("config: only settings.json and gateway.json, no service stop, backup first", async () => {
    expect(await run(["--scope", "config", "--yes"])).toBe(0);
    expect(await exists(h("settings.json"))).toBe(false);
    expect(await exists(h("gateway.json"))).toBe(false);
    expect(await exists(h("credentials.json"))).toBe(true);
    expect(calls).toEqual([]);
    expect(f.stdout()).toMatch(/Backup: .*tropos-backup-/);
    expect(f.stdout()).toContain("Next: tcode onboard");
    expect((await readdir(h("backups"))).length).toBe(2);
  });

  test("default scope removes credentials, pairing, sessions, chats, projects; keeps memory, cron, workspace; stops the service", async () => {
    expect(await run(["--yes"])).toBe(0);
    expect(calls).toEqual(["stop"]);
    for (const p of ["settings.json", "credentials.json", "gateway/pairing.json", "gateway/sessions.json", "gateway/chats.json", "projects/k/s.jsonl"]) expect(await exists(h(p))).toBe(false);
    expect(await exists(h("projects/k/settings.json"))).toBe(true);
    for (const p of ["memories/m.md", "gateway/cron/jobs.json", "workspace/code.ts"]) expect(await exists(h(p))).toBe(true);
  });

  test("full: everything but earlier backups; the new backup is outside the home and holds the workspace", async () => {
    expect(await run(["--scope", "full", "--yes"])).toBe(0);
    expect(await readdir(f.ctx.home)).toEqual(["backups"]);
    expect(await readdir(h("backups"))).toEqual(["older.tar.gz"]);
    const archives = (await readdir(f.ctx.userHome)).filter((n) => n.startsWith("tropos-backup-"));
    expect(archives.length).toBe(1);
    const { verifyBackup } = await import("../../backup");
    const v = await verifyBackup({ archive: join(f.ctx.userHome, archives[0]!) });
    expect(v.manifest?.files.map((x) => x.path)).toContain("workspace/code.ts");
  });

  test("--dry-run lists and changes nothing; --no-backup makes none", async () => {
    expect(await run(["--scope", "full", "--dry-run"])).toBe(0);
    expect(f.stdout()).toContain(h("settings.json"));
    expect(await exists(h("settings.json"))).toBe(true);
    expect(calls).toEqual([]);
    expect(await run(["--scope", "config", "--yes", "--no-backup"])).toBe(0);
    expect(await readdir(h("backups"))).toEqual(["older.tar.gz"]);
  });

  test("needs --yes without a terminal, asks on a terminal, bad scope is a usage error", async () => {
    expect(await run([])).toBe(64);
    expect(await run(["--scope", "everything", "--yes"])).toBe(64);
    expect(await exists(h("settings.json"))).toBe(true);
    const t = await makeFixture({ interactive: true, answers: [false] });
    await mkdir(t.ctx.home, { recursive: true });
    await writeFile(join(t.ctx.home, "settings.json"), "{}");
    expect(await run(["--scope", "config"], {}, t.ctx)).toBe(1);
    expect(await exists(join(t.ctx.home, "settings.json"))).toBe(true);
    await t.cleanup();
  });

  test("a service that will not stop aborts before anything is deleted", async () => {
    expect(await run(["--yes"], { stopThrows: true })).toBe(1);
    expect(await exists(h("credentials.json"))).toBe(true);
  });

  test("a full reset refuses a directory that is not Tropos data", async () => {
    const odd = join(f.ctx.userHome, "documents");
    await mkdir(odd, { recursive: true });
    await writeFile(join(odd, "a.txt"), "x");
    expect(await run(["--scope", "full", "--yes"], {}, { ...f.ctx, home: odd })).toBe(1);
    expect(await exists(join(odd, "a.txt"))).toBe(true);
  });

  test.each(["config", "config+creds+sessions"])("scope %s also refuses a hostile TROPOS_HOME (the user's home, a directory that is not Tropos data)", async (scope) => {
    // e.g. a project's .envrc exporting TROPOS_HOME=~ : settings.json and history.jsonl there are not Tropos's.
    const userHome = f.ctx.userHome;
    await mkdir(userHome, { recursive: true });
    for (const name of ["settings.json", "gateway.json", "credentials.json", "history.jsonl"]) await writeFile(join(userHome, name), "mine");
    expect(await run(["--scope", scope, "--yes", "--no-backup"], {}, { ...f.ctx, home: userHome, env: { ...f.ctx.env, TROPOS_HOME: userHome } })).toBe(1);
    expect(f.stderr()).toMatch(/refusing/);
    for (const name of ["settings.json", "gateway.json", "credentials.json", "history.jsonl"]) expect(await exists(join(userHome, name))).toBe(true);

    const odd = join(userHome, "documents");
    await mkdir(odd, { recursive: true });
    await writeFile(join(odd, "settings.json"), "x");
    expect(await run(["--scope", scope, "--yes", "--no-backup"], {}, { ...f.ctx, home: odd })).toBe(1);
    expect(await exists(join(odd, "settings.json"))).toBe(true);
  });
});
