// src/cli/lifecycle/backup.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import run from "./backup";
import { makeFixture, type Fixture } from "./lifecycle-fixture";

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
  await mkdir(join(f.ctx.home, "memories"), { recursive: true });
  await writeFile(join(f.ctx.home, "settings.json"), '{"theme":"dark"}');
  await writeFile(join(f.ctx.home, "memories", "a.md"), "A");
});
afterEach(() => f.cleanup());

test("create --dry-run lists files and writes nothing", async () => {
  expect(await run(["create", "--dry-run"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain("settings.json");
  expect(await readdir(f.ctx.home)).not.toContain("backups");
});

test("create, list, verify, restore round trip; restore needs --yes without a terminal", async () => {
  expect(await run(["create", "--verify", "--output", join(f.root, "out")], f.ctx)).toBe(0);
  const archive = f.stdout().match(/Backup written: (\S+)/)![1]!;
  expect(archive.startsWith(join(f.root, "out"))).toBe(true);
  expect(await run(["verify", archive], f.ctx)).toBe(0);
  await writeFile(join(f.ctx.home, "memories", "a.md"), "changed");
  expect(await run(["restore", archive], f.ctx)).toBe(64);
  expect(await readFile(join(f.ctx.home, "memories", "a.md"), "utf8")).toBe("changed");
  expect(await run(["restore", archive, "--yes", "--only", "memory"], f.ctx)).toBe(0);
  expect(await readFile(join(f.ctx.home, "memories", "a.md"), "utf8")).toBe("A");
  expect(await run(["list"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain("tropos-safety-");
});

test("a broken archive, an unknown part and bad usage", async () => {
  await writeFile(join(f.root, "bad.tar.gz"), "junk");
  expect(await run(["verify", join(f.root, "bad.tar.gz")], f.ctx)).toBe(1);
  expect(f.stderr()).toContain("failed verification");
  expect(await run(["restore", join(f.root, "bad.tar.gz"), "--yes"], f.ctx)).toBe(1);
  expect(await run(["restore", join(f.root, "bad.tar.gz"), "--only", "nonsense", "--yes"], f.ctx)).toBe(64);
  expect(await run(["bogus"], f.ctx)).toBe(64);
  expect(await run([], f.ctx)).toBe(64);
});

async function riskyArchive(): Promise<string> {
  await writeFile(join(f.ctx.home, "SOUL.md"), "mine");
  expect(await run(["create", "--output", join(f.root, "out")], f.ctx)).toBe(0);
  const archive = f.stdout().match(/Backup written: (\S+)/)![1]!;
  await writeFile(join(f.ctx.home, "SOUL.md"), "changed");
  return archive;
}

test("restore of a backup with files that run code or let people in needs --trust-code besides --yes", async () => {
  const archive = await riskyArchive();
  expect(await run(["restore", archive, "--yes"], f.ctx)).toBe(1);
  expect(f.stdout()).toContain("This backup replaces files that can run code or let people in");
  expect(f.stdout()).toContain("SOUL.md");
  expect(f.stderr()).toContain("--trust-code");
  expect(await readFile(join(f.ctx.home, "SOUL.md"), "utf8")).toBe("changed");
  expect(await run(["restore", archive, "--yes", "--trust-code"], f.ctx)).toBe(0);
  expect(await readFile(join(f.ctx.home, "SOUL.md"), "utf8")).toBe("mine");
});

test("interactively the risky files get their own confirmation, shown prominently", async () => {
  const archive = await riskyArchive();
  const no = await makeFixture({ interactive: true, answers: [true, false] });
  no.ctx.home = f.ctx.home;
  no.ctx.cwd = f.ctx.cwd;
  expect(await run(["restore", archive], no.ctx)).toBe(1);
  expect(no.stdout()).toContain("This backup replaces files that can run code or let people in");
  expect(no.stdout()).toContain("SOUL.md");
  expect(no.asked).toHaveLength(2);
  expect(no.asked[1]).toMatch(/trust/i);
  expect(await readFile(join(f.ctx.home, "SOUL.md"), "utf8")).toBe("changed");

  const yes = await makeFixture({ interactive: true, answers: [true, true] });
  yes.ctx.home = f.ctx.home;
  expect(await run(["restore", archive], yes.ctx)).toBe(0);
  expect(await readFile(join(f.ctx.home, "SOUL.md"), "utf8")).toBe("mine");
});

test("--dry-run prints the risky files and changes nothing", async () => {
  const archive = await riskyArchive();
  expect(await run(["restore", archive, "--dry-run"], f.ctx)).toBe(0);
  expect(f.stdout()).toContain("This backup replaces files that can run code or let people in");
  expect(f.stdout()).toContain("SOUL.md");
  expect(await readFile(join(f.ctx.home, "SOUL.md"), "utf8")).toBe("changed");
});
