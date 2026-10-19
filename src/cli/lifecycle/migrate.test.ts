import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeHermes, makeOpenClaw } from "../../migrate/fixtures";
import { makeFixture, type Fixture } from "./lifecycle-fixture";
import run from "./migrate";

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
  await makeOpenClaw(join(f.ctx.userHome, ".openclaw"));
  await makeHermes(join(f.ctx.userHome, ".hermes"));
});
afterEach(() => f.cleanup());
const exists = (p: string) => stat(p).then(() => true, () => false);

describe("tcode migrate", () => {
  test("--help is 0; no args and bad flags are 64", async () => {
    expect(await run(["--help"], f.ctx)).toBe(0);
    expect(f.stdout()).toContain("tcode migrate <openclaw|hermes>");
    expect(await run([], f.ctx)).toBe(64);
    expect(await run(["--bogus"], f.ctx)).toBe(64);
    expect(await run(["nope"], f.ctx)).toBe(64);
    expect(await run(["hermes", "--only", "bad"], f.ctx)).toBe(64);
    expect(await run(["hermes", "--skill-conflict", "x"], f.ctx)).toBe(64);
  });

  test("a Hermes import on an old home migrates the layout first", async () => {
    await mkdir(join(f.ctx.home, "memories"), { recursive: true });
    await writeFile(join(f.ctx.home, "memories", "USER.md"), "Prefers tabs");
    expect(await run(["hermes", "--yes", "--no-backup"], f.ctx)).toBe(0);
    const user = await readFile(join(f.ctx.home, "workspace", "USER.md"), "utf8");
    expect(user).toContain("Prefers tabs");
    expect(user).toContain("Prefers metric units");
    expect(await exists(join(f.ctx.home, "memories"))).toBe(false);
  });

  test("without a terminal it needs --yes or --dry-run", async () => {
    expect(await run(["openclaw"], f.ctx)).toBe(64);
    expect(f.stderr()).toContain("--yes");
    expect(await exists(f.ctx.home)).toBe(false);
  });

  test("--dry-run prints the plan and writes nothing; --json is parseable", async () => {
    expect(await run(["openclaw", "--dry-run"], f.ctx)).toBe(0);
    expect(f.stdout()).toContain("dry run");
    expect(f.stdout()).toContain("SOUL.md");
    expect(f.stdout()).toContain("Suggestion: Model in the source");
    expect(await exists(f.ctx.home)).toBe(false);
    const g = await makeFixture();
    await makeHermes(join(g.ctx.userHome, ".hermes"));
    expect(await run(["hermes", "--dry-run", "--json"], g.ctx)).toBe(0);
    const j = JSON.parse(g.stdout());
    expect(j.dryRun).toBe(true);
    expect(j.items.length).toBeGreaterThan(0);
    await g.cleanup();
  });

  test("--yes imports, and a second run reports nothing to do", async () => {
    expect(await run(["hermes", "--yes"], f.ctx)).toBe(0);
    expect(await readFile(join(f.ctx.home, "workspace", "SOUL.md"), "utf8")).toContain("Hermes");
    expect(f.stdout()).toContain("Imported");
    expect(await exists(join(f.ctx.home, "credentials.json"))).toBe(false);
    const out = f.stdout().length;
    expect(await run(["hermes", "--yes"], f.ctx)).toBe(0);
    expect(f.stdout().slice(out)).not.toContain("[create]");
  });

  test("--only limits what is planned; --migrate-secrets writes the key", async () => {
    expect(await run(["hermes", "--yes", "--only", "skills", "--migrate-secrets", "--no-backup"], f.ctx)).toBe(0);
    expect(await readFile(join(f.ctx.home, "workspace", "SOUL.md"), "utf8")).toBe(""); // laid out empty, nothing imported into it
    expect(await exists(join(f.ctx.home, "workspace", "skills", "docker-tips", "SKILL.md"))).toBe(true);
    expect(await readFile(join(f.ctx.home, "credentials.json"), "utf8")).toContain("sk-or-123");
    expect(f.stdout()).not.toContain("sk-or-123");
  });

  test("interactive: declining changes nothing", async () => {
    const g = await makeFixture({ interactive: true, answers: [false] });
    await makeHermes(join(g.ctx.userHome, ".hermes"));
    expect(await run(["hermes"], g.ctx)).toBe(1);
    expect(g.stdout()).toContain("Cancelled");
    expect(await exists(g.ctx.home)).toBe(false);
    await g.cleanup();
  });

  test("the dry run and the confirmation say that imported text becomes instructions, and list each file", async () => {
    expect(await run(["hermes", "--dry-run"], f.ctx)).toBe(0);
    expect(f.stdout()).toContain("become instructions the agent follows in every session");
    expect(f.stdout()).toContain('"You are Hermes, a careful assistant."');
    const g = await makeFixture({ interactive: true, answers: [false] });
    await makeHermes(join(g.ctx.userHome, ".hermes"));
    await run(["hermes"], g.ctx);
    expect(g.stdout()).toContain("become instructions the agent follows in every session");
    expect(g.asked[0]).toContain("instructions the agent follows in every session");
    await g.cleanup();
  });

  test("--allow-scripts is accepted; by default imported skill files are not executable", async () => {
    await writeFile(join(f.ctx.userHome, ".hermes", "skills", "notes", "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    expect(await run(["hermes", "--yes", "--only", "skills"], f.ctx)).toBe(0);
    expect((await stat(join(f.ctx.home, "workspace", "skills", "notes", "run.sh"))).mode & 0o111).toBe(0);
    const g = await makeFixture();
    await makeHermes(join(g.ctx.userHome, ".hermes"));
    await writeFile(join(g.ctx.userHome, ".hermes", "skills", "notes", "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    expect(await run(["hermes", "--yes", "--only", "skills", "--allow-scripts"], g.ctx)).toBe(0);
    expect((await stat(join(g.ctx.home, "workspace", "skills", "notes", "run.sh"))).mode & 0o777).toBe(0o700);
    await g.cleanup();
  });

  test("a missing source is exit 1 with the places it looked", async () => {
    const g = await makeFixture();
    expect(await run(["hermes", "--dry-run"], g.ctx)).toBe(1);
    expect(g.stderr()).toContain("No hermes installation");
    await g.cleanup();
  });

  test("list shows installed sources", async () => {
    expect(await run(["list"], f.ctx)).toBe(0);
    expect(f.stdout()).toContain("openclaw");
    expect(f.stdout()).toContain("hermes");
    expect(f.stdout()).toContain("skills: 2");
  });
});
