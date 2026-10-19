// src/tools/setup/setup-tool.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { loadGatewayConfig } from "../../gateway/config";
import { Ledger } from "../../learning/ledger";
import { createAdmin, type Admin } from "../../web/admin";
import { toolKind } from "../types";
import { SecretVault } from "./secrets";
import { createSetupTool, type SetupToolDeps } from "./setup-tool";

const LOCAL = { role: "owner", origin: "local" } as const;
const CHAT = { role: "owner", origin: "channel" } as const;
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

let root: string;
let home: string;
let userHome: string;
let ledger: Ledger;
let calls: [string, unknown][];
let answers: Record<string, (p: unknown) => unknown>;
let admin: Admin;
let reloads: number;
let tool: ReturnType<typeof createSetupTool>;

// The real admin over a throwaway home, recording every call; `answers` stands in for what reaches outside (Telegram,
// the service manager, the updater).
beforeEach(async () => {
  root = await makeTmpDir();
  home = join(root, "tropos");
  userHome = join(root, "user");
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
  ledger = new Ledger(home);
  calls = [];
  answers = {};
  reloads = 0;
  const real = createAdmin({
    home,
    userHome,
    env: { HOME: userHome, TROPOS_HOME: home, PATH: "" },
    version: "1.0.0",
    execPath: "/usr/local/bin/tcode",
    cwd: root,
    now: Date.now,
    fetch: (async () => {
      throw new Error("network is off in tests");
    }) as unknown as typeof fetch,
  });
  admin = {
    handle: async (m, p) => {
      calls.push([m, p]);
      return answers[m] ? answers[m](p) : real.handle(m, p);
    },
    methods: () => [],
  };
  tool = createSetupTool(deps());
});
afterEach(() => removeDir(root));

function deps(over: Partial<SetupToolDeps> = {}): SetupToolDeps {
  return { home, userHome, who: LOCAL, admin, ledger, reload: async () => void reloads++, ...over };
}

const text = (out: { content: unknown }) => String(out.content);

test("is an exec tool named TroposSetup that targets setup:<action>", () => {
  const t = createSetupTool(deps());
  expect([t.name, toolKind(t)]).toEqual(["TroposSetup", "exec"]);
  expect(t.subject({ action: "model.set" }, "/x")).toEqual({ paths: [], target: "setup:model.set" });
});

test("a guest's call is refused before anything runs", async () => {
  const out = await createSetupTool(deps({ who: { role: "guest", origin: "channel" } })).run({ action: "model.set", model: "m" }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(calls).toEqual([]);
});

test("in a chat the doctor's fixes are refused with the dashboard link", async () => {
  const out = await createSetupTool(deps({ who: CHAT })).run({ action: "doctor.fix", finding: "config.drift" }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(text(out)).toContain("http://");
  expect(calls).toEqual([]);
});

test("model.set writes through config.set and records an undoable ledger entry", async () => {
  const out = await tool.run({ action: "model.set", model: "openai/gpt-5" }, makeToolContext());
  expect(calls).toContainEqual(["config.set", { file: "settings", path: "model", value: "openai/gpt-5" }]);
  expect(text(out)).toContain("Saved: new sessions use openai/gpt-5. This conversation keeps its current model until you start a new one (/new).");
  const [entry] = await ledger.list(1);
  expect(entry).toMatchObject({ kind: "setup", configPath: "model", actor: "agent" });
  expect(entry!.noUndo).toBeUndefined();
  expect((await ledger.undo(entry!.id)).ok).toBe(true);
  expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).model).toBeUndefined();
});

test("model and effort are recorded as two entries", async () => {
  await tool.run({ action: "model.set", model: "openai/gpt-5", effort: "high" }, makeToolContext());
  expect((await ledger.list()).map((e) => e.configPath).sort()).toEqual(["effort", "model"]);
});

test("autonomy.lower is recorded but can never be undone (undo would raise it)", async () => {
  await tool.run({ action: "autonomy.lower", level: "ask" }, makeToolContext());
  const [entry] = await ledger.list(1);
  expect(entry!.noUndo).toContain("Settings → Autonomy");
  expect((await ledger.undo(entry!.id)).ok).toBe(false);
  expect((await loadGatewayConfig(home)).chat.autonomy).toBe("ask");
  expect(reloads).toBe(1);
});

test("raising autonomy is refused with the dashboard pointer and nothing is recorded", async () => {
  await writeFile(join(home, "gateway.json"), JSON.stringify({ chat: { autonomy: "ask", backend: "host" } }));
  const out = await tool.run({ action: "autonomy.lower", level: "autonomous" }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(text(out)).toContain("Settings → Autonomy");
  expect(await ledger.list()).toEqual([]);
  expect((await loadGatewayConfig(home)).chat.autonomy).toBe("ask");
});

test("project.create in a chat registers the folder and switches the chat to it", async () => {
  const selected: string[] = [];
  await createSetupTool(deps({ who: CHAT, chatKey: "telegram:1", selectProject: async (id) => void selected.push(id) })).run({ action: "project.create", name: "Space Game" }, makeToolContext());
  expect(selected).toEqual(["space-game"]);
  expect((await loadGatewayConfig(home)).projects.map((p) => p.id)).toEqual(["space-game"]);
  expect((await ledger.list()).map((e) => e.configPath)).toContain("projects");
});

test("project.remove records every value it changed", async () => {
  const dir = join(userHome, "app");
  await mkdir(dir);
  await tool.run({ action: "project.add", path: dir }, makeToolContext());
  await tool.run({ action: "project.remove", project: "app" }, makeToolContext());
  expect(calls).toContainEqual(["projects.remove", { id: "app" }]);
  const removal = (await ledger.list()).filter((e) => e.action === "project.remove").map((e) => e.configPath).sort();
  expect(removal).toEqual(["projects", "removedProjectPaths"]);
});

test("mcp.add takes env keys from the vault and the ledger never holds them", async () => {
  const vault = new SecretVault();
  vault.seal(KEY);
  const t = createSetupTool(deps({ secrets: vault }));
  const out = await t.run({ action: "mcp.add", name: "gh", server: { command: "npx", args: ["-y", "srv"], env: { GITHUB_TOKEN: "secret:1" } } }, makeToolContext());
  expect(out.isError).toBeFalsy();
  expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).mcpServers.gh.env.GITHUB_TOKEN).toBe(KEY);
  expect(JSON.stringify(out)).not.toContain(KEY);
  expect(await readFile(ledger.file, "utf8")).not.toContain(KEY);
  const [entry] = await ledger.list(1);
  expect(entry).toMatchObject({ configPath: "mcpServers.gh" });
});

test("an unknown or expired ref in an MCP env asks for the key again and writes nothing", async () => {
  const out = await createSetupTool(deps({ secrets: new SecretVault() })).run({ action: "mcp.add", name: "gh", server: { command: "npx", env: { GITHUB_TOKEN: "secret:4" } } }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(text(out)).toContain("Send that key again; I only hold it for 30 minutes.");
  expect(calls).toEqual([]);
});

test("mcp.disable and proactive.set go through the admin and are recorded", async () => {
  await tool.run({ action: "mcp.add", name: "gh", server: { command: "npx" } }, makeToolContext());
  await tool.run({ action: "mcp.disable", name: "gh" }, makeToolContext());
  expect(calls).toContainEqual(["mcp.setEnabled", { name: "gh", enabled: false }]);
  await tool.run({ action: "proactive.set", enabled: false, maxPerDay: 2 }, makeToolContext());
  expect(calls).toContainEqual(["proactive.set", { enabled: false, maxPerDay: 2 }]);
  const paths = (await ledger.list()).map((e) => e.configPath);
  expect(paths).toContain("mcpServers.gh.disabled");
  expect(paths).toContain("proactive");
});

test("an admin failure comes back as an error with secrets scrubbed", async () => {
  answers["config.set"] = () => {
    throw new Error(`bad value ${KEY}`);
  };
  const out = await tool.run({ action: "model.set", model: "x" }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(text(out)).not.toContain(KEY);
});

test("the preview is the before → after of the change", () => {
  expect(tool.preview!({ action: "model.set", model: "openai/gpt-5" })!.text).toContain("→ openai/gpt-5");
});
