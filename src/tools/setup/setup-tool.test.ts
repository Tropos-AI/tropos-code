// src/tools/setup/setup-tool.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { loadGatewayConfig } from "../../gateway/config";
import { Ledger } from "../../learning/ledger";
import { createAdmin, type Admin } from "../../web/admin";
import type { ProviderControl } from "../../ui/runtime";
import { toolKind } from "../types";
import { SecretVault } from "./secrets";
import { createSetupTool, type SetupToolDeps } from "./setup-tool";

const LOCAL = { role: "owner", origin: "local" } as const;
const CHAT = { role: "owner", origin: "channel" } as const;
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ";

let root: string;
let home: string;
let userHome: string;
let ledger: Ledger;
let calls: [string, unknown][];
let answers: Record<string, (p: unknown) => unknown>;
let admin: Admin;
let reloads: number;
let vault: SecretVault;
let providers: ProviderControl & { models: ProviderControl["models"]; connected: [string, string][]; disconnected: string[] };
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
  // Nothing here may reach the real service manager, updater or doctor.
  answers = {
    "service.status": () => ({ manager: "launchd", installed: true, running: true, logPath: "/x.log" }),
    "service.restart": () => ({ manager: "launchd", installed: true, running: true }),
    "update.run": () => ({ ok: true, from: "1.0.0", to: "1.0.0", message: "Already up to date." }),
    "doctor.run": () => ({ findings: [{ id: "config.drift", area: "config", level: "warn", message: "settings.json drifted", fixable: true }], summary: { ok: 3, info: 0, warn: 1, error: 0, fixed: 0 } }),
    "doctor.fix": () => ({ ok: true, message: "Fixed." }),
    "channels.telegram.set": () => ({ connected: true }),
  };
  reloads = 0;
  vault = new SecretVault();
  vault.seal(KEY);
  providers = {
    connected: [],
    disconnected: [],
    status: async () => [],
    connect: async (id, key) => void providers.connected.push([id, key]),
    disconnect: async (id) => (providers.disconnected.push(id), true),
    models: async () => ["m1", "m2"],
  };
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
  return { home, userHome, who: LOCAL, admin, ledger, reload: async () => void reloads++, secrets: vault, providers, ...over };
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

test("mcp.add refuses loader and interpreter variables (and every other non-key entry) and points to Settings → Extensions", async () => {
  const names = ["NODE_OPTIONS", "NODE_PATH", "npm_config_userconfig", "BUN_INSTALL", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "PYTHONPATH", "PERL5OPT", "RUBYOPT",
    "JAVA_TOOL_OPTIONS", "BASH_ENV", "ENV", "ZDOTDIR", "GIT_SSH_COMMAND", "LOG_LEVEL", "SSL_CERT_FILE", "HOME"];
  for (const name of names) {
    const out = await tool.run({ action: "mcp.add", name: "x", server: { command: "node", env: { [name]: "--require=/tmp/x.js" } } }, makeToolContext());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain(name);
    expect(text(out)).toContain("Add servers that need other environment settings from Settings → Extensions.");
  }
  // A loader variable is refused even when its value is a vault ref.
  const ref = await tool.run({ action: "mcp.add", name: "x", server: { command: "node", env: { NODE_OPTIONS: "secret:1" } } }, makeToolContext());
  expect(text(ref)).toContain("Add servers that need other environment settings from Settings → Extensions.");
  expect(calls).toEqual([]);
  expect(vault.peek("secret:1")).toBeDefined();
});

test("mcp.add refuses a raw key in the env: keys come as secret:<n> refs", async () => {
  for (const env of [{ API_KEY: KEY }, { GITHUB_TOKEN: "plain-value-123" }, { API: KEY }]) {
    const out = await tool.run({ action: "mcp.add", name: "x", server: { command: "node", env } }, makeToolContext());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("secret:<n>");
    expect(JSON.stringify(out)).not.toContain(KEY);
  }
  expect(calls).toEqual([]);
});

test("mcp.add refuses what the approval couldn't show whole: long, multi-line, invisible or non-ASCII commands, args and URLs, and env entries that aren't vault keys", async () => {
  const long = "x".repeat(201);
  const cases = [
    { server: { command: `node\rcurl evil` }, says: "The command" },
    { server: { command: "nоde" }, says: "The command" }, // a Cyrillic o
    { server: { command: "node", args: ["ok", long] }, says: "Argument 2" },
    { server: { command: "node", args: ["a\nb"] }, says: "Argument 1" },
    { server: { command: "node", args: ["a\u200bb"] }, says: "Argument 1" },
    { server: { command: "node", args: ["a\u2028b"] }, says: "Argument 1" },
    { server: { command: "node", args: ["a\u202eb"] }, says: "Argument 1" },
    { server: { type: "http" as const, url: `https://x/${long}` }, says: "The URL" },
    { server: { command: "node", env: { BLOB_TOKEN: long } }, says: "other environment settings" },
    { server: { command: "node", env: { NOTE_TOKEN: "secret:1\nNODE_OPTIONS=x" } }, says: "other environment settings" },
    { server: { command: "node", env: { "BAD NAME_TOKEN": "secret:1" } }, says: "other environment settings" },
    { server: { command: "node", env: { "1X_TOKEN": "secret:1" } }, says: "other environment settings" },
    { server: { command: "node", env: { github_token: "secret:1" } }, says: "other environment settings" },
  ];
  for (const c of cases) {
    const out = await tool.run({ action: "mcp.add", name: "x", server: c.server }, makeToolContext());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain(c.says);
  }
  expect(calls).toEqual([]);
});

test("mcp.add writes an allowed key from the vault and no other env", async () => {
  await tool.run({ action: "mcp.add", name: "x", server: { command: "node", args: ["server.js"], env: { SERVICE_API_KEY: "secret:1" } } }, makeToolContext());
  expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).mcpServers.x).toEqual({ type: "stdio", command: "node", args: ["server.js"], env: { SERVICE_API_KEY: KEY } });
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

// ---- Task 7: Telegram, provider keys, doctor, restart and update

test("telegram.connect takes the sealed token, never shows it, and is not undoable", async () => {
  const v = new SecretVault();
  v.seal(TOKEN);
  const out = await createSetupTool(deps({ secrets: v })).run({ action: "telegram.connect", secret: "secret:1" }, makeToolContext());
  expect(calls).toContainEqual(["channels.telegram.set", { token: TOKEN }]);
  expect(JSON.stringify(out)).not.toContain(TOKEN);
  expect(v.peek("secret:1")).toBeUndefined();
  expect((await ledger.list(1))[0]!.noUndo).toBe("Disconnect it instead.");
  expect(await readFile(ledger.file, "utf8")).not.toContain(TOKEN);
});

test("an expired or unknown ref asks for the token again", async () => {
  const out = await tool.run({ action: "telegram.connect", secret: "secret:9" }, makeToolContext());
  expect(out).toMatchObject({ isError: true });
  expect(String(out.content)).toContain("Send that key again");
  expect(calls).toEqual([]);
});

test("a raw token (a format the vault didn't know) is used but never repeated, even in an error", async () => {
  answers["channels.telegram.set"] = (p) => {
    throw new Error(`Telegram did not accept ${(p as { token: string }).token}`);
  };
  const out = await tool.run({ action: "telegram.connect", secret: TOKEN }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(JSON.stringify(out)).not.toContain(TOKEN);
});

test("from a chat, telegram.connect and provider.connect take only secret:<n> refs; a raw value is refused with the dashboard link", async () => {
  const chat = createSetupTool(deps({ who: CHAT }));
  const telegram = await chat.run({ action: "telegram.connect", secret: TOKEN }, makeToolContext());
  expect(telegram.isError).toBe(true);
  expect(text(telegram)).toContain("#/settings/channels");
  const provider = await chat.run({ action: "provider.connect", provider: "mistral", secret: "Xq7Rk2Lm9Np4Tz8Bv3Cw6Hd1Jf5Gs0Ya-but-unsealed" }, makeToolContext());
  expect(provider.isError).toBe(true);
  expect(text(provider)).toContain("#/settings/models");
  expect(JSON.stringify([telegram, provider])).not.toContain(TOKEN);
  expect(calls).toEqual([]);
  expect(providers.connected).toEqual([]);
  // A ref still works from the chat.
  expect((await chat.run({ action: "provider.connect", provider: "anthropic", secret: "secret:1" }, makeToolContext())).isError).toBeFalsy();
});

test("a project name, path or id the approval couldn't show faithfully is refused before anything runs", async () => {
  for (const input of [
    { action: "project.add" as const, path: "/w/evil\u202etxt" },
    { action: "project.create" as const, name: "x\u200by" },
    { action: "project.rename" as const, project: "app", name: "two\nlines" },
    { action: "project.default" as const, project: "a\u0000b" },
    { action: "model.set" as const, model: "m\u2028x" },
  ]) {
    const out = await tool.run(input, makeToolContext());
    expect({ input, isError: out.isError }).toEqual({ input, isError: true });
    expect(text(out)).toContain("can't show it to you for approval");
  }
  expect(calls).toEqual([]);
});

test("telegram.disconnect clears the token; in a chat the preview warns that the chat goes quiet", async () => {
  await tool.run({ action: "telegram.disconnect" }, makeToolContext());
  expect(calls).toContainEqual(["channels.telegram.clear", undefined]);
  expect(createSetupTool(deps({ who: CHAT })).preview!({ action: "telegram.disconnect" })!.text).toContain("You won't reach me on Telegram until it's connected again.");
  expect(tool.preview!({ action: "telegram.disconnect" })!.text).not.toContain("You won't reach me");
});

test("provider.connect checks the key by listing models and removes a rejected one", async () => {
  providers.models = async () => {
    throw new Error("401");
  };
  const out = await tool.run({ action: "provider.connect", provider: "anthropic", secret: "secret:1" }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(providers.disconnected).toEqual(["anthropic"]);
  expect(JSON.stringify(out)).not.toContain(KEY);
});

test("provider.connect with a good key connects it and is recorded as not undoable", async () => {
  const out = await tool.run({ action: "provider.connect", provider: "anthropic", secret: "secret:1" }, makeToolContext());
  expect(out.isError).toBeFalsy();
  expect(providers.connected).toEqual([["anthropic", KEY]]);
  expect(JSON.stringify(out)).not.toContain(KEY);
  expect((await ledger.list(1))[0]!.noUndo).toBe("Disconnect it instead.");
  expect(await readFile(ledger.file, "utf8")).not.toContain(KEY);
});

test("doctor.run never fixes; doctor.fix runs one finding locally", async () => {
  const report = await tool.run({ action: "doctor.run" }, makeToolContext());
  expect(calls).toContainEqual(["doctor.run", { fix: false }]);
  expect(String(report.content)).toContain("config.drift");
  expect(await ledger.list()).toEqual([]);
  await tool.run({ action: "doctor.fix", finding: "config.drift" }, makeToolContext());
  // Only a safe fix: anything that could lose data is for `tcode doctor --fix` at the computer.
  expect(calls).toContainEqual(["doctor.fix", { id: "config.drift", safeOnly: true }]);
  expect((await ledger.list(1))[0]!.noUndo).toBe("This can't be undone.");
});

test("in a chat doctor.run is still read-only", async () => {
  await createSetupTool(deps({ who: CHAT })).run({ action: "doctor.run" }, makeToolContext());
  expect(calls).toEqual([["doctor.run", { fix: false }]]);
});

test("inside the gateway, restart answers first and restarts after the delay", async () => {
  const timers: [() => void, number][] = [];
  const out = await createSetupTool(deps({ inGateway: true, restartDelayMs: 3000, setTimer: (fn, ms) => timers.push([fn, ms]) })).run({ action: "service.restart" }, makeToolContext());
  expect(String(out.content)).toContain("Restarting");
  expect(timers.map(([, ms]) => ms)).toEqual([3000]);
  expect(calls.some(([m]) => m === "service.restart")).toBe(false);
  timers[0]![0]();
  await Bun.sleep(0);
  expect(calls.some(([m]) => m === "service.restart")).toBe(true);
  expect((await ledger.list(1))[0]!.noUndo).toBe("This can't be undone.");
});

test("inside the gateway the restart delay defaults to 3 seconds", async () => {
  const timers: number[] = [];
  await createSetupTool(deps({ inGateway: true, setTimer: (_fn, ms) => timers.push(ms) })).run({ action: "service.restart" }, makeToolContext());
  expect(timers).toEqual([3000]);
});

test("a restart without the service installed points to the dashboard", async () => {
  answers["service.status"] = () => ({ manager: "launchd", installed: false, running: false, logPath: "/x.log" });
  const out = await tool.run({ action: "service.restart" }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(String(out.content)).toContain("The background service isn't installed. Open http://");
  expect(calls.some(([m]) => m === "service.restart")).toBe(false);
});

test("tropos.update runs the update and restarts a running service", async () => {
  answers["update.run"] = () => ({ ok: true, from: "0.4.1", to: "0.5.0", message: "Updated." });
  answers["service.status"] = () => ({ manager: "launchd", installed: true, running: true });
  await tool.run({ action: "tropos.update" }, makeToolContext());
  expect(calls.map(([m]) => m)).toEqual(expect.arrayContaining(["update.run", "service.restart"]));
  expect((await ledger.list(1))[0]!.noUndo).toBe("This can't be undone.");
});

test("a failed update does not restart anything", async () => {
  answers["update.run"] = () => ({ ok: false, from: "0.4.1", message: "No network." });
  const out = await tool.run({ action: "tropos.update" }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(calls.some(([m]) => m === "service.restart")).toBe(false);
});
