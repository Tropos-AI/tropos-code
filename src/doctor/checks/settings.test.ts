import { afterEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { byId, makeFixture, runOne, type Fixture } from "../testing";
import { settingsCheck } from "./settings";

let fx: Fixture;
afterEach(() => fx?.close());

test("no settings files is fine", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, settingsCheck);
  expect(r.findings[0]).toMatchObject({ level: "ok" });
});

test("valid user settings parse", async () => {
  fx = await makeFixture();
  await fx.write("settings.json", JSON.stringify({ theme: "dark" }));
  const r = await runOne(fx, settingsCheck);
  expect(r.findings[0]!.message).toContain("1 settings file");
});

test("a broken user file and a broken project file are both reported with file and reason", async () => {
  fx = await makeFixture();
  const user = await fx.write("settings.json", "{ nope");
  const project = join(fx.root, ".tropos", "settings.json");
  await Bun.write(project, JSON.stringify({ theme: "purple" }));
  const r = await runOne(fx, settingsCheck);
  expect(r.summary.error).toBe(2);
  const u = r.findings.find((f) => f.id === "settings.parse.user")!;
  expect(u.message).toContain(user);
  expect(u.detail).toBeTruthy();
  const p = r.findings.find((f) => f.id === "settings.parse.project")!;
  expect(p.message).toContain(project);
  expect(p.detail).toContain("theme");
});

test("--fix moves a broken user settings file aside and keeps its valid keys", async () => {
  fx = await makeFixture();
  const path = await fx.write("settings.json", JSON.stringify({ theme: "dark", effort: "turbo" }));
  const plain = await runOne(fx, settingsCheck);
  expect(byId(plain, "settings.parse.user")).toMatchObject({ fixable: true, safe: false, data: { path } });
  const r = await runOne(fx, settingsCheck, { fix: true });
  expect(byId(r, "settings.parse.user")).toMatchObject({ fixed: true });
  expect(byId(r, "settings.parse.user")!.fixMessage).toContain("kept the valid settings; dropped: effort. The original is in ");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "dark" });
  expect((await readdir(fx.home)).some((n) => /^settings\.json\.broken-\d{14}$/.test(n))).toBe(true);
});

test("unparsable user settings are not rewritten: the fix refuses and says why; a broken repo file is not fixable", async () => {
  fx = await makeFixture();
  const path = await fx.write("settings.json", "{ nope");
  const project = join(fx.root, ".tropos", "settings.json");
  await Bun.write(project, JSON.stringify({ theme: "purple" }));
  const r = await runOne(fx, settingsCheck, { fix: true });
  const u = byId(r, "settings.parse.user")!;
  expect(u.fixed).toBeFalsy();
  expect(u.fixMessage).toContain("isn't valid JSON");
  expect(await readFile(path, "utf8")).toBe("{ nope");
  expect((await readdir(fx.home)).some((n) => n.startsWith("settings.json.broken-"))).toBe(false);
  const p = byId(r, "settings.parse.project")!;
  expect(p.fixable).toBeUndefined();
  expect(p.fixed).toBeUndefined();
  expect(await readFile(project, "utf8")).toContain("purple");
});

test("an invalid allow rule goes on its own; an invalid deny or ask rule is never dropped: the fix refuses", async () => {
  fx = await makeFixture();
  const path = await fx.write("settings.json", JSON.stringify({ theme: "dark", permissions: { deny: ["Bash(rm:*)"], ask: ["Edit"], allow: ["Read", 5] } }));
  const r = await runOne(fx, settingsCheck, { fix: true });
  expect(byId(r, "settings.parse.user")!.fixMessage).toContain("dropped: permissions.allow[1]. The original is in ");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "dark", permissions: { deny: ["Bash(rm:*)"], ask: ["Edit"], allow: ["Read"] } });

  for (const permissions of [{ deny: ["Bash(rm:*)", 5] }, { ask: ["Edit", null] }]) {
    const text = JSON.stringify({ theme: "dark", permissions });
    await Bun.write(path, text);
    const f = byId(await runOne(fx, settingsCheck, { fix: true }), "settings.parse.user")!;
    expect(f.fixed).toBeFalsy();
    expect(f.fixMessage).toContain("never drops");
    expect(await readFile(path, "utf8")).toBe(text);
  }
});

test("a hook group with an invalid matcher goes as a whole, never just its matcher (that would widen it to every tool)", async () => {
  fx = await makeFixture();
  const good = { matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] };
  const path = await fx.write("settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: 5, hooks: [{ type: "command", command: "guard" }] }, good] } }));
  const f = byId(await runOne(fx, settingsCheck, { fix: true }), "settings.parse.user")!;
  expect(f.fixMessage).toContain("dropped: hooks.PreToolUse[0]. The original is in ");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ hooks: { PreToolUse: [good] } });
});

test("an MCP server with a bad field goes as a whole entry; a learning block holding askBeforeSaving is never dropped", async () => {
  fx = await makeFixture();
  const path = await fx.write("settings.json", JSON.stringify({ mcpServers: { bad: { type: "http", url: "not a url" }, ok: { command: "srv" } } }));
  const f = byId(await runOne(fx, settingsCheck, { fix: true }), "settings.parse.user")!;
  expect(f.fixMessage).toContain("dropped: mcpServers.bad. The original is in ");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { ok: { command: "srv" } } });

  const text = JSON.stringify({ learning: { askBeforeSaving: true, interval: 1 } });
  await Bun.write(path, text);
  const g = byId(await runOne(fx, settingsCheck, { fix: true }), "settings.parse.user")!;
  expect(g.fixed).toBeFalsy();
  expect(g.fixMessage).toContain("learning.askBeforeSaving");
  expect(await readFile(path, "utf8")).toBe(text);
});

test("deny or ask rules that would have to go as a whole are never dropped: the fix refuses and leaves the file", async () => {
  for (const permissions of [{ deny: "Bash(rm:*)" }, { ask: { Edit: true } }, "deny everything"]) {
    fx = await makeFixture();
    const text = JSON.stringify({ theme: "dark", permissions });
    const path = await fx.write("settings.json", text);
    const r = await runOne(fx, settingsCheck, { fix: true });
    const f = byId(r, "settings.parse.user")!;
    expect(f.fixed).toBeFalsy();
    expect(f.fixMessage).toContain("never drops");
    expect(await readFile(path, "utf8")).toBe(text);
    expect((await readdir(fx.home)).some((n) => n.startsWith("settings.json.broken-"))).toBe(false);
    await fx.close();
  }
});

test("the fix message names what it dropped; a nested bad entry drops only that entry and unknown keys survive", async () => {
  fx = await makeFixture();
  const good = { matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] };
  const path = await fx.write("settings.json", JSON.stringify({ theme: "dark", futureKey: 1, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" }] }, good] } }));
  const r = await runOne(fx, settingsCheck, { fix: true });
  const f = byId(r, "settings.parse.user")!;
  expect(f.fixed).toBe(true);
  expect(f.fixMessage).toContain("dropped: hooks.PreToolUse[0].hooks[0]. The original is in ");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "dark", futureKey: 1, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }, good] } });
});

test("fixing twice in one second does not overwrite the first backup", async () => {
  fx = await makeFixture();
  const path = await fx.write("settings.json", JSON.stringify({ effort: "turbo" }));
  await runOne(fx, settingsCheck, { fix: true });
  await Bun.write(path, JSON.stringify({ effort: "warp" }));
  await runOne(fx, settingsCheck, { fix: true });
  expect((await readdir(fx.home)).filter((n) => n.startsWith("settings.json.broken-"))).toHaveLength(2);
});
