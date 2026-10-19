import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extensionsHandlers } from "./extensions";
import { adminOverWs, makeKit, writeText, type Kit } from "./ops-testkit";

const SERVER = join(import.meta.dir, "../../../test/helpers/mcp-test-server.ts");
let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.cleanup());

const settings = async () => JSON.parse(await readFile(join(kit.home, "settings.json"), "utf8")) as Record<string, any>;
const stdio = (extra: object = {}) => ({ type: "stdio" as const, command: process.execPath, args: [SERVER], ...extra });

test("add writes user settings and returns the list; env values are never listed", async () => {
  await writeText(join(kit.home, "settings.json"), '{"model":"claude-sonnet-5-5"}');
  const h = extensionsHandlers(kit.ctx);
  const list = await h["mcp.add"]!({ name: "files", server: stdio({ args: ["--flag"], env: { API_KEY: "sk-abcdef1234567890" } }) });
  expect(list).toEqual([{ name: "files", type: "stdio", target: `${process.execPath} --flag`, state: "unknown" }]);
  expect(JSON.stringify(list)).not.toContain("sk-abcdef");
  const saved = await settings();
  expect(saved.model).toBe("claude-sonnet-5-5");
  expect(saved.mcpServers.files.env.API_KEY).toBe("sk-abcdef1234567890");
  // the store rotates a backup of what was there
  expect(await readFile(join(kit.home, "settings.json.bak"), "utf8")).toContain("claude-sonnet-5-5");
});

test("http servers show their URL without query or credentials, and never their headers", async () => {
  const h = extensionsHandlers(kit.ctx);
  const list = await h["mcp.add"]!({ name: "remote", server: { type: "http", url: "https://user:pw@example.com/mcp?token=abc", headers: { Authorization: "Bearer hunter2hunter2" } } });
  expect(list[0]).toEqual({ name: "remote", type: "http", target: "https://example.com/mcp", state: "unknown" });
  expect(JSON.stringify(list)).not.toMatch(/hunter2|token=abc|user:pw/);
});

test("names and shapes are validated", async () => {
  const h = extensionsHandlers(kit.ctx);
  for (const name of ["", "a b", "../x", "x".repeat(41), "a/b"]) await expect(h["mcp.add"]!({ name, server: stdio() })).rejects.toThrow(/Server names/);
  await expect(h["mcp.add"]!({ name: "x", server: { type: "stdio" } })).rejects.toThrow(/command/);
  await expect(h["mcp.add"]!({ name: "x", server: { type: "http" } })).rejects.toThrow(/URL/);
  await expect(h["mcp.add"]!({ name: "x", server: { type: "http", url: "not a url" } })).rejects.toThrow(/valid/);
  await expect(h["mcp.add"]!({ name: "x", server: { type: "ws" as never } })).rejects.toThrow(/type/);
  // the settings schema's own limits still apply (32 characters, no "__")
  await expect(h["mcp.add"]!({ name: "a__b", server: stdio() })).rejects.toThrow(/__/);
  await h["mcp.add"]!({ name: "x", server: stdio() });
  await expect(h["mcp.add"]!({ name: "x", server: stdio() })).rejects.toThrow(/already exists/);
});

test("remove deletes only that server", async () => {
  const h = extensionsHandlers(kit.ctx);
  await h["mcp.add"]!({ name: "a", server: stdio() });
  await h["mcp.add"]!({ name: "b", server: stdio() });
  expect((await h["mcp.remove"]!({ name: "a" })).map((s) => s.name)).toEqual(["b"]);
  await expect(h["mcp.remove"]!({ name: "a" })).rejects.toThrow(/no server/);
});

test("list merges live state from a manager, and shows disabled servers", async () => {
  await writeText(join(kit.home, "settings.json"), JSON.stringify({ mcpServers: { up: stdio(), down: stdio(), off: stdio({ disabled: true }), idle: stdio() } }));
  const h = extensionsHandlers(kit.ctx, {
    manager: () => ({
      status: () => [
        { name: "up", state: "connected", tools: 3, type: "stdio" },
        { name: "down", state: "failed", tools: 0, error: "Bearer abcdef0123456789 refused", type: "stdio" },
      ],
    }),
  });
  const byName = Object.fromEntries((await h["mcp.list"]!(undefined)).map((s) => [s.name, s]));
  expect(byName.up).toMatchObject({ state: "connected", tools: 3 });
  expect(byName.down).toMatchObject({ state: "failed" });
  expect(byName.down!.error).not.toContain("abcdef0123456789");
  expect(byName.off!.state).toBe("disabled");
  expect(byName.idle!.state).toBe("unknown");
});

test("test lists a real stdio server's tools", async () => {
  const r = await extensionsHandlers(kit.ctx)["mcp.test"]!({ server: stdio() });
  expect(r.ok).toBe(true);
  expect(r.tools).toEqual(expect.arrayContaining(["add", "echo"]));
});

test("test reports a missing command, and never echoes env values", async () => {
  const h = extensionsHandlers(kit.ctx);
  const missing = await h["mcp.test"]!({ server: { type: "stdio", command: "/nonexistent/tropos-mcp-server" } });
  expect(missing).toMatchObject({ ok: false, tools: [] });
  expect(missing.error).toBeTruthy();
  const leaky = await h["mcp.test"]!({ server: { type: "stdio", command: "sh", args: ["-c", 'echo "using $MYVAL and sk-leakyleakyleaky1" >&2; exit 1'], env: { MYVAL: "plainsecretvalue" } } });
  expect(leaky.ok).toBe(false);
  expect(leaky.error).toContain("using");
  expect(leaky.error).not.toContain("plainsecretvalue");
  expect(leaky.error).not.toContain("sk-leakyleaky");
});

test("test times out a server that never answers and kills the child", async () => {
  const pidFile = join(kit.root, "pid");
  const r = await extensionsHandlers(kit.ctx, { timeoutMs: 600 })["mcp.test"]!({
    server: { type: "stdio", command: "sh", args: ["-c", `echo $$ > "${pidFile}"; exec "${process.execPath}" "${SERVER}" --hang`] },
  });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Timed out|timed out/i);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(100);
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
});

test("test of an unreachable http server does not echo header values", async () => {
  const r = await extensionsHandlers(kit.ctx, { timeoutMs: 3000 })["mcp.test"]!({ server: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer topsecret12345" } } });
  expect(r.ok).toBe(false);
  expect(r.error ?? "").not.toContain("topsecret12345");
});

async function plugin(name: string) {
  const root = join(kit.home, "plugins", name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "plugin.json"), JSON.stringify({ name }));
}

test("plugins.setEnabled edits disabledPlugins through the store and checks the plugin exists", async () => {
  await plugin("alpha");
  await plugin("beta");
  const h = extensionsHandlers(kit.ctx);
  expect(await h["plugins.setEnabled"]!({ name: "alpha", enabled: false })).toEqual({ name: "alpha", enabled: false });
  await h["plugins.setEnabled"]!({ name: "beta", enabled: false });
  expect((await settings()).disabledPlugins).toEqual(["alpha", "beta"]);
  await h["plugins.setEnabled"]!({ name: "alpha", enabled: true });
  expect((await settings()).disabledPlugins).toEqual(["beta"]);
  await h["plugins.setEnabled"]!({ name: "beta", enabled: true });
  expect((await settings()).disabledPlugins).toBeUndefined();
  await expect(h["plugins.setEnabled"]!({ name: "ghost", enabled: false })).rejects.toThrow(/no plugin/);
  await expect(h["plugins.setEnabled"]!({ name: "alpha", enabled: "no" as never })).rejects.toThrow();
});

test("end to end over the WebSocket", async () => {
  await plugin("alpha");
  const ws = await adminOverWs(kit.ctx, extensionsHandlers(kit.ctx));
  try {
    expect(await ws.call("mcp.add", { name: "files", server: stdio() })).toMatchObject({ ok: true, result: [{ name: "files" }] });
    expect(await ws.call("mcp.list")).toMatchObject({ ok: true, result: [{ name: "files", state: "unknown" }] });
    expect(await ws.call("mcp.test", { server: stdio() })).toMatchObject({ ok: true, result: { ok: true } });
    expect(await ws.call("mcp.add", { name: "bad name", server: stdio() })).toMatchObject({ ok: false });
    expect(await ws.call("plugins.setEnabled", { name: "alpha", enabled: false })).toMatchObject({ ok: true, result: { enabled: false } });
    expect(await ws.call("mcp.remove", { name: "files" })).toMatchObject({ ok: true, result: [] });
  } finally {
    await ws.close();
  }
});

test("mcp.add, mcp.remove and plugins.setEnabled ask the gateway to reload once saved; a refused change doesn't", async () => {
  let reloads = 0;
  const own = await makeKit({ gateway: { runCronNow: async () => {}, reload: async () => void reloads++, devicesChanged: async () => {} } });
  try {
    await mkdir(join(own.home, "plugins", "alpha"), { recursive: true });
    await writeFile(join(own.home, "plugins", "alpha", "plugin.json"), JSON.stringify({ name: "alpha" }));
    const h = extensionsHandlers(own.ctx);
    await h["mcp.add"]!({ name: "files", server: stdio() });
    expect(reloads).toBe(1);
    await h["mcp.remove"]!({ name: "files" });
    expect(reloads).toBe(2);
    await h["plugins.setEnabled"]!({ name: "alpha", enabled: false });
    expect(reloads).toBe(3);
    await expect(h["mcp.remove"]!({ name: "files" })).rejects.toThrow(/no server/);
    expect(reloads).toBe(3);
  } finally {
    await own.cleanup();
  }
});

test("setEnabled writes disabled: true and removes it again; an unknown name is refused", async () => {
  const h = extensionsHandlers(kit.ctx);
  await h["mcp.add"]!({ name: "files", server: stdio() });
  const off = await h["mcp.setEnabled"]!({ name: "files", enabled: false });
  expect(off).toMatchObject([{ name: "files", state: "disabled" }]);
  expect((await settings()).mcpServers.files.disabled).toBe(true);
  const on = await h["mcp.setEnabled"]!({ name: "files", enabled: true });
  expect(on[0]!.state).not.toBe("disabled");
  expect("disabled" in (await settings()).mcpServers.files).toBe(false);
  await expect(h["mcp.setEnabled"]!({ name: "ghost", enabled: false })).rejects.toThrow(/no server named ghost/);
  await expect(h["mcp.setEnabled"]!({ name: "files", enabled: "no" as never })).rejects.toThrow(/true or false/);
});
