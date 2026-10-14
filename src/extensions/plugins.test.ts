import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { loadPlugins, pluginRoots } from "./plugins";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

async function put(rel: string, content: unknown): Promise<void> {
  const path = join(home, "plugins", rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}

test("no plugins folder means no plugins and no warnings", async () => {
  expect(await loadPlugins(home, [])).toEqual({ plugins: [], warnings: [] });
});

test("loads manifests, hooks and MCP servers, filling in the plugin root", async () => {
  await put("kit/.claude-plugin/plugin.json", { name: "my-kit", version: "1.2.0", description: "Tools", author: { name: "x" } });
  await put("kit/hooks/hooks.json", {
    description: "Claude Code wraps events",
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/check.sh", timeout: 5 }] }] },
  });
  await put("kit/.mcp.json", {
    mcpServers: {
      db: { command: "${TROPOS_PLUGIN_ROOT}/bin/db", args: ["--root", "${CLAUDE_PLUGIN_ROOT}"], env: { HOME_DIR: "${CLAUDE_PLUGIN_ROOT}" }, cwd: "${CLAUDE_PLUGIN_ROOT}/x" },
      web: { type: "http", url: "https://example.com/mcp" },
    },
  });
  await mkdir(join(home, "plugins", "bare"), { recursive: true });
  await put("bare/hooks/hooks.json", { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] });
  await put("bare/.mcp.json", { mcpServers: { s: { command: "srv" } } });
  const { plugins, warnings } = await loadPlugins(home, []);
  expect(warnings).toEqual([]);
  const root = join(home, "plugins", "kit");
  expect(plugins).toEqual([
    {
      name: "bare",
      root: join(home, "plugins", "bare"),
      version: undefined,
      description: undefined,
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
      mcpServers: { "bare-s": { command: "srv" } },
      enabled: true,
    },
    {
      name: "my-kit",
      root,
      version: "1.2.0",
      description: "Tools",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${root}/check.sh`, timeout: 5 }] }] },
      mcpServers: {
        "my-kit-db": { command: `${root}/bin/db`, args: ["--root", root], env: { HOME_DIR: root }, cwd: `${root}/x` },
        "my-kit-web": { type: "http", url: "https://example.com/mcp" },
      },
      enabled: true,
    },
  ]);
  expect(pluginRoots(plugins)).toEqual([
    { name: "bare", root: join(home, "plugins", "bare") },
    { name: "my-kit", root },
  ]);
});

test("manifest precedence: .tropos-plugin, then .claude-plugin, then plugin.json", async () => {
  await put("a/.tropos-plugin/plugin.json", { name: "first" });
  await put("a/.claude-plugin/plugin.json", { name: "second" });
  await put("b/plugin.json", { name: "third" });
  const { plugins } = await loadPlugins(home, []);
  expect(plugins.map((p) => p.name)).toEqual(["first", "third"]);
});

test("disabled plugins are listed without contributions and left out of the roots", async () => {
  await put("off/hooks/hooks.json", "{ not json");
  await put("on/plugin.json", {});
  const { plugins, warnings } = await loadPlugins(home, ["off"]);
  expect(warnings).toEqual([]);
  expect(plugins.map((p) => [p.name, p.enabled, p.hooks])).toEqual([
    ["off", false, {}],
    ["on", true, {}],
  ]);
  expect(pluginRoots(plugins).map((p) => p.name)).toEqual(["on"]);
});

test("broken plugins and files become warnings, never exceptions", async () => {
  await put("badjson/plugin.json", "{ nope");
  await put("badname/plugin.json", { name: "Not Kebab" });
  await put("Upper/hooks/hooks.json", {});
  await put("dup-a/plugin.json", { name: "same" });
  await put("dup-b/plugin.json", { name: "same" });
  await put("hooks-bad/hooks/hooks.json", { PreToolUse: [{ hooks: [{ type: "prompt", command: "x" }] }] });
  await put("hooks-json/hooks/hooks.json", "{");
  await put("hooks-array/hooks/hooks.json", []);
  await put("hooks-events/hooks/hooks.json", { Notification: [], Stop: [{ hooks: [{ type: "command", command: "ok" }] }] });
  await put("mcp-bad/.mcp.json", { mcpServers: { "bad name": { command: "x" }, nocmd: { args: [] }, good: { command: "g" } } });
  await put("mcp-json/.mcp.json", "nope");
  await put("mcp-shape/.mcp.json", { mcpServers: [1] });
  await put("file-not-dir", "x");
  await put(".hidden/plugin.json", { name: "hidden" });
  await symlink(join(home, "nowhere"), join(home, "plugins", "dangling"));
  const { plugins, warnings } = await loadPlugins(home, []);
  expect(plugins.map((p) => p.name)).toEqual(["same", "hooks-array", "hooks-bad", "hooks-events", "hooks-json", "mcp-bad", "mcp-json", "mcp-shape"]);
  const by = (name: string) => plugins.find((p) => p.name === name)!;
  expect(by("hooks-events").hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "ok" }] }] });
  expect(by("mcp-bad").mcpServers).toEqual({ "mcp-bad-good": { command: "g" } });
  const text = warnings.join("\n");
  for (const fragment of [
    "Skipped plugin badjson: bad manifest",
    "Skipped plugin badname: plugin.json: name: plugin names are kebab-case",
    "Skipped plugin Upper: plugin names are kebab-case",
    "Skipped plugin dup-b: another plugin is already named same",
    "Plugin hooks-bad: hooks/hooks.json ignored",
    "Plugin hooks-json: cannot read hooks/hooks.json",
    "Plugin hooks-array: hooks/hooks.json must be an object",
    "Plugin hooks-events: ignored unsupported hook events: Notification",
    'Plugin mcp-bad: MCP server "bad name" skipped',
    'Plugin mcp-bad: MCP server "nocmd" skipped',
    "Plugin mcp-json: cannot read .mcp.json",
    "Plugin mcp-shape: .mcp.json ignored",
  ]) {
    expect(text).toContain(fragment);
  }
  expect(warnings).toHaveLength(12);
});

test("an unreadable plugins folder is a warning", async () => {
  if (process.getuid?.() === 0) return;
  await mkdir(join(home, "plugins"));
  await chmod(join(home, "plugins"), 0o000);
  const result = await loadPlugins(home, []);
  await chmod(join(home, "plugins"), 0o755);
  expect(result.plugins).toEqual([]);
  expect(result.warnings[0]).toStartWith("Cannot read");
});
