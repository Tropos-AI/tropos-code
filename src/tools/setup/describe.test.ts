// src/tools/setup/describe.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { describeSetupChange, readSetupState } from "./describe";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

test("the preview shows before → after and an MCP server's full command", () => {
  const s = { settings: { model: "anthropic/claude-opus-5-5" }, gateway: {} };
  expect(describeSetupChange({ action: "model.set", model: "openai/gpt-5" }, s).text).toContain("model: anthropic/claude-opus-5-5 → openai/gpt-5");
  const mcp = describeSetupChange({ action: "mcp.add", name: "gh", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "secret:2" } } }, s).text;
  expect(mcp).toContain("command: npx -y @modelcontextprotocol/server-github");
  expect(mcp).toContain('env: "GITHUB_TOKEN"=(secret:2)');
  expect(describeSetupChange({ action: "proactive.set", enabled: false }, { settings: {}, gateway: { telegram: { botToken: "x" } } }).text).toContain("proactive messages: on → off");
});

test("a raw secret in the request never appears in the preview", () => {
  const raw = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const s = { settings: {}, gateway: {} };
  for (const input of [
    { action: "provider.connect" as const, provider: "anthropic", secret: raw },
    { action: "telegram.connect" as const, secret: raw },
    { action: "mcp.add" as const, name: "x", server: { command: "x", env: { KEY: raw } } },
  ]) {
    expect(describeSetupChange(input, s).text).not.toContain(raw);
  }
});

test("lowering autonomy names what changes, and project overrides that are clamped", () => {
  const s = { settings: {}, gateway: { chat: { autonomy: "balanced" }, projects: [{ id: "app", autonomy: "autonomous" }, { id: "web", autonomy: "ask" }] } };
  const text = describeSetupChange({ action: "autonomy.lower", level: "ask" }, s).text;
  expect(text).toContain("autonomy: balanced → ask");
  expect(text).toContain("app: autonomous → ask");
  expect(text).not.toContain("web:");
});

test("readSetupState reads both files and treats an unreadable one as empty", async () => {
  await writeFile(join(home, "settings.json"), JSON.stringify({ model: "m" }));
  await writeFile(join(home, "gateway.json"), "{ not json");
  expect(readSetupState(home)).toEqual({ settings: { model: "m" }, gateway: {} });
});

test("every env value that is not a key is shown in full and JSON-quoted, so a loader variable can't hide in the approval", () => {
  const s = { settings: {}, gateway: {} };
  const text = describeSetupChange({ action: "mcp.add", name: "x", server: { command: "node", env: { NODE_OPTIONS: "--require=/tmp/x.js", LOG_LEVEL: "debug" } } }, s).text;
  expect(text).toContain('"NODE_OPTIONS"="--require=/tmp/x.js" (refused: set it in Settings → Extensions)');
  expect(text).toContain('"LOG_LEVEL"="debug" (refused');
  expect(text).not.toContain("(hidden)");
});

test("nothing is ever cut: a value too long or with a line break is shown as refused, not shortened", () => {
  const s = { settings: {}, gateway: {} };
  const long = "x".repeat(201);
  const text = describeSetupChange({ action: "mcp.add", name: "x", server: { command: "node", args: [long, "a\nrm -rf ~"], env: { BLOB: long, NL: "ok\nPATH=/tmp" } } }, s).text;
  expect(text).not.toContain("x".repeat(200));
  expect(text).not.toContain("…");
  expect(text).not.toContain("rm -rf");
  expect(text).not.toContain("PATH=/tmp");
  expect(text.match(/\(refused: it is longer than 200 characters\)/g)).toHaveLength(2);
  expect(text.match(/\(refused: it holds a line break, a control or invisible character, or a non-ASCII character\)/g)).toHaveLength(2);
});

test("env names are quoted with anything invisible escaped", () => {
  const text = describeSetupChange({ action: "mcp.add", name: "x", server: { command: "node", env: { "A\u202eB": "secret:1" } } }, { settings: {}, gateway: {} }).text;
  expect(text).toContain('"A\\u202eB"=');
  expect(text).not.toContain("\u202e");
});

test("names, paths and ids in the preview are shown only when they hold no control, invisible or bidi character", () => {
  const s = { settings: {}, gateway: { projects: [{ id: "app", name: "Ap‮p", path: "/w/app\u0007" }] } };
  const add = describeSetupChange({ action: "project.add", path: "/w/evil‮txt.exe", name: "ok\nprojects: nothing" }, s).text;
  expect(add).not.toContain("‮");
  expect(add).not.toContain("\n projects: nothing");
  expect(add).toContain("refused");
  const rename = describeSetupChange({ action: "project.rename", project: "app", name: "New" }, s).text;
  expect(rename).not.toContain("‮");
  const remove = describeSetupChange({ action: "project.remove", project: "app" }, s).text;
  expect(remove).not.toContain("\u0007");
  // Letters beyond ASCII are names like any other.
  expect(describeSetupChange({ action: "project.create", name: "Εργασία" }, s).text).toContain('"Εργασία"');
});

// ---- MCP edit/remove/test/list, plugins, skills from a URL, downloads

const RUNNING = { settings: { mcpServers: { gh: { command: "npx", args: ["-y", "srv"], env: { GITHUB_TOKEN: "ghp_realvalue1234567890abcdefghijklmnopqr", REGION: "eu-west" } } } }, gateway: {} };

test("mcp.edit shows the command before → after, names new keys by ref and never shows a kept value", () => {
  const text = describeSetupChange({ action: "mcp.edit", name: "gh", server: { args: ["-y", "srv@2"], env: { NEW_API_KEY: "secret:3" } } }, RUNNING).text;
  expect(text).toContain("command: npx -y srv → npx -y srv@2");
  expect(text).toContain('"NEW_API_KEY"=(secret:3)');
  expect(text).toContain("kept: GITHUB_TOKEN, REGION (values not shown)");
  expect(text).not.toContain("ghp_realvalue");
  expect(text).not.toContain("eu-west");
  expect(describeSetupChange({ action: "mcp.edit", name: "nope", server: { args: [] } }, RUNNING).text).toContain("no MCP server named nope");
});

test("mcp.remove, mcp.test and mcp.list say what happens and what runs", () => {
  expect(describeSetupChange({ action: "mcp.remove", name: "gh" }, RUNNING).text).toContain("MCP server gh: remove (npx -y srv)");
  const probe = describeSetupChange({ action: "mcp.test", name: "gh" }, RUNNING).text;
  expect(probe).toContain("npx -y srv");
  expect(probe).toContain("then stop it");
  expect(describeSetupChange({ action: "mcp.list" }, RUNNING).text).toContain("Read-only");
});

test("plugin.install shows exactly what is fetched and that nothing from it runs now", () => {
  const s = { settings: {}, gateway: {}, home: "/h/.tropos" };
  const clone = describeSetupChange({ action: "plugin.install", source: "https://github.com/acme/kit/tree/main/plugins/x" }, s).text;
  expect(clone).toContain("clone (shallow, no git hooks run): https://github.com/acme/kit.git, branch main, folder plugins/x");
  expect(clone).toContain("into: /h/.tropos/plugins");
  expect(clone).toContain("Nothing from it runs now");
  expect(describeSetupChange({ action: "plugin.install", source: "https://github.com/acme/market", name: "beta" }, s).text).toContain("the plugin beta from that marketplace");
  expect(describeSetupChange({ action: "plugin.install", source: "/Users/me/kit" }, s).text).toContain("copy the folder: /Users/me/kit");
  expect(describeSetupChange({ action: "plugin.install", source: "http://x/y.git" }, s).text).toContain("(refused:");
});

test("plugin.enable lists every program the plugin runs, read from disk; one the approval can't show is refused", async () => {
  const root = join(home, "plugins", "guard");
  await mkdir(join(root, "hooks"), { recursive: true });
  await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "guard" }));
  await writeFile(join(root, "hooks", "hooks.json"), JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: "echo bye" }, { type: "command", command: "evil‮cmd" }] }] }));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { db: { command: "node", args: ["db.js"] } } }));
  const state = { ...readSetupState(home), home };
  const text = describeSetupChange({ action: "plugin.enable", name: "guard" }, { ...state, settings: { disabledPlugins: ["guard"] } }).text;
  expect(text).toContain("plugin guard: off → on");
  expect(text).toContain("hook Stop: echo bye");
  expect(text).toContain("MCP server guard-db: node db.js");
  expect(text).toContain("hook Stop: (refused:");
  expect(text).not.toContain("‮");
  expect(describeSetupChange({ action: "plugin.remove", name: "guard" }, state).text).toContain(`Delete the plugin guard and its folder ${root}`);
  expect(describeSetupChange({ action: "plugin.enable", name: "ghost" }, state).text).toContain("no plugin named ghost");
});

test("skill.install and download show the URL, where it goes and the limits", () => {
  const s = { settings: {}, gateway: {}, home: "/h/.tropos" };
  const skill = describeSetupChange({ action: "skill.install", source: "https://github.com/acme/kit/blob/main/skills/pdf/SKILL.md" }, s).text;
  expect(skill).toContain("fetch: https://raw.githubusercontent.com/acme/kit/main/skills/pdf/SKILL.md");
  expect(skill).toContain("checked for injected instructions");
  const dl = describeSetupChange({ action: "download", url: "https://example.com/files/data.zip" }, s).text;
  expect(dl).toContain("download: https://example.com/files/data.zip");
  expect(dl).toContain("save as: data.zip (in this project's folder)");
  expect(dl).toContain("never replaces a file that is already there");
  expect(dl).toContain("200 MB");
  expect(describeSetupChange({ action: "download", url: "https://example.com/a", path: "/w/app/a.bin", overwrite: true }, s).text).toContain("replaces the file at /w/app/a.bin if there is one");
  expect(describeSetupChange({ action: "download", url: "https://127.0.0.1/a" }, s).text).toContain("(refused:");
});
