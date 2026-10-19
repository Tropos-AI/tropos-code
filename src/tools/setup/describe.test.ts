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
  expect(mcp).toContain("env: GITHUB_TOKEN=(secret:2)");
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
