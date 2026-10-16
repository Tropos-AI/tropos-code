import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configHandlers } from "./config";
import { adminWith, failure, makeKit, type Kit } from "./host-testkit";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.close());

const admin = () => adminWith(kit, configHandlers(kit.ctx));
const settingsPath = () => join(kit.home, "settings.json");
const onDisk = async (path = settingsPath()) => JSON.parse(await readFile(path, "utf8")) as Record<string, any>;

test("config.get masks secrets with the API mask and reports the schema and mtime", async () => {
  await writeFile(settingsPath(), JSON.stringify({ env: { MY_API_KEY: "real-key-123", PLAIN: "x" }, autoUpdates: false }));
  const v = (await admin().handle("config.get", { file: "settings" })) as any;
  expect(v.file).toBe("settings");
  expect(v.path).toBe(settingsPath());
  expect(v.value).toEqual({ env: { MY_API_KEY: "••••", PLAIN: "x" }, autoUpdates: false });
  expect(JSON.stringify(v)).not.toContain("real-key-123");
  expect(v.schema).toBeTruthy();
  expect(typeof v.modifiedAt).toBe("string");
  expect(await failure(admin(), "config.get", { file: "nope" })).toContain("settings");
});

test("a missing file reads as empty with no modifiedAt", async () => {
  const v = (await admin().handle("config.get", { file: "gateway" })) as any;
  expect(v.value).toEqual({});
  expect(v.modifiedAt).toBeUndefined();
});

test("config.set validates (issue path in the message), writes with a backup, and null unsets", async () => {
  const a = admin();
  const v = (await a.handle("config.set", { file: "settings", path: "autoUpdatesChannel", value: "stable" })) as any;
  expect(v.value.autoUpdatesChannel).toBe("stable");
  expect(await failure(a, "config.set", { file: "settings", path: "autoUpdatesChannel", value: "nightly" })).toContain("autoUpdatesChannel");
  expect((await onDisk()).autoUpdatesChannel).toBe("stable");
  await a.handle("config.set", { file: "settings", path: "autoUpdates", value: false });
  expect((await stat(`${settingsPath()}.bak`)).isFile()).toBe(true);
  const gone = (await a.handle("config.set", { file: "settings", path: "autoUpdates", value: null })) as any;
  expect(gone.value.autoUpdates).toBeUndefined();
  expect(await failure(a, "config.set", { file: "settings", path: "a..b", value: 1 })).toContain("not a valid path");
});

test("config.set on the gateway file goes through the gateway schema and the file stays private", async () => {
  const a = admin();
  const path = join(kit.home, "gateway.json");
  await a.handle("config.set", { file: "gateway", path: "idleMinutes", value: 45 });
  expect((await onDisk(path)).idleMinutes).toBe(45);
  expect((await stat(path)).mode & 0o077).toBe(0);
  expect(await failure(a, "config.set", { file: "gateway", path: "idleMinutes", value: 0 })).toContain("idleMinutes");
});

test("config.set with the mask keeps the stored secret, and refuses a mask with nothing to keep", async () => {
  await writeFile(settingsPath(), JSON.stringify({ env: { MY_API_KEY: "real-key-123" } }));
  const a = admin();
  await a.handle("config.set", { file: "settings", path: "env", value: { MY_API_KEY: "••••", OTHER: "1" } });
  expect((await onDisk()).env).toEqual({ MY_API_KEY: "real-key-123", OTHER: "1" });
  await a.handle("config.set", { file: "settings", path: "env.MY_API_KEY", value: "••••" });
  expect((await onDisk()).env.MY_API_KEY).toBe("real-key-123");
  expect(await failure(a, "config.set", { file: "settings", path: "env.NEW_API_KEY", value: "••••" })).toContain("masked placeholder");
  expect((await onDisk()).env.NEW_API_KEY).toBeUndefined();
});

test("config.raw is redacted text and a masked round trip through config.apply keeps the real key", async () => {
  await writeFile(settingsPath(), JSON.stringify({ env: { MY_API_KEY: "real-key-123" }, mcpServers: { s: { command: "x", env: { TOKEN: "tok-secret-1" } } } }));
  const a = admin();
  const raw = (await a.handle("config.raw", { file: "settings" })) as { text: string; path: string };
  expect(raw.text).not.toContain("real-key-123");
  expect(raw.text).not.toContain("tok-secret-1");
  expect(raw.text).toContain("••••");
  const edited = raw.text.replace('"command": "x"', '"command": "y"');
  const v = (await a.handle("config.apply", { file: "settings", text: edited })) as any;
  const disk = await onDisk();
  expect(disk.env.MY_API_KEY).toBe("real-key-123");
  expect(disk.mcpServers.s.env.TOKEN).toBe("tok-secret-1");
  expect(disk.mcpServers.s.command).toBe("y");
  expect(JSON.stringify(v)).not.toContain("real-key-123");
});

test("config.apply replaces the file (removed keys go), refuses bad values, and names the line of a JSON error", async () => {
  await writeFile(settingsPath(), JSON.stringify({ autoUpdates: false, snapshots: false }));
  const a = admin();
  await a.handle("config.apply", { file: "settings", text: '{"snapshots": true}' });
  expect(await onDisk()).toEqual({ snapshots: true });
  expect(await failure(a, "config.apply", { file: "settings", text: '{"autoUpdatesChannel": "x"}' })).toContain("autoUpdatesChannel");
  const msg = await failure(a, "config.apply", { file: "settings", text: '{\n  "snapshots": true,\n  "memory": \n}' });
  expect(msg).toContain("line 4");
  expect(await failure(a, "config.apply", { file: "settings", text: "[1]" })).toContain("JSON object");
  expect(await failure(a, "config.apply", { file: "settings", text: '{"env": {"NEW_API_KEY": "••••"}}' })).toContain("no saved value");
  expect(await onDisk()).toEqual({ snapshots: true });
});

test("mcpServers env and headers are masked completely and the mask round trip keeps the stored values", async () => {
  await writeFile(settingsPath(), JSON.stringify({ mcpServers: { s: { command: "x", env: { REGION: "eu-west", DEBUG_LEVEL: "verbose" } }, h: { type: "http", url: "https://mcp.example/a", headers: { "X-Org": "acme-corp" } } } }));
  const a = admin();
  const view = (await a.handle("config.get", { file: "settings" })) as any;
  expect(JSON.stringify(view.value)).not.toMatch(/eu-west|verbose|acme-corp/);
  expect(view.value.mcpServers.s.env).toEqual({ REGION: "••••", DEBUG_LEVEL: "••••" });
  expect(view.value.mcpServers.h.headers).toEqual({ "X-Org": "••••" });
  const raw = (await a.handle("config.raw", { file: "settings" })) as { text: string };
  expect(raw.text).not.toMatch(/eu-west|verbose|acme-corp/);
  await a.handle("config.apply", { file: "settings", text: raw.text.replace('"command": "x"', '"command": "y"') });
  const disk = await onDisk();
  expect(disk.mcpServers.s.env).toEqual({ REGION: "eu-west", DEBUG_LEVEL: "verbose" });
  expect(disk.mcpServers.h.headers).toEqual({ "X-Org": "acme-corp" });
  expect(disk.mcpServers.s.command).toBe("y");
  await a.handle("config.set", { file: "settings", path: "mcpServers.s.env", value: { REGION: "••••", DEBUG_LEVEL: "trace" } });
  expect((await onDisk()).mcpServers.s.env).toEqual({ REGION: "eu-west", DEBUG_LEVEL: "trace" });
});

test("config.set and config.apply ask the gateway to reload once the file is saved; a refused change doesn't", async () => {
  const a = admin();
  await a.handle("config.set", { file: "gateway", path: "telegram.botToken", value: "123:abc" });
  expect(kit.reloads).toBe(1);
  await a.handle("config.apply", { file: "settings", text: '{"snapshots": true}' });
  expect(kit.reloads).toBe(2);
  await failure(a, "config.set", { file: "settings", path: "autoUpdatesChannel", value: "nightly" });
  await failure(a, "config.apply", { file: "settings", text: "[1]" });
  expect(kit.reloads).toBe(2);
});
