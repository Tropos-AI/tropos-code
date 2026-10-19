// src/tools/setup/describe.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
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
