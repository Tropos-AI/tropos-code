// src/config/store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { ConfigStoreError, gatewayFile, getAt, jsonSchemaOf, parsePath, readUserSettingsRaw, redact, redactAt, setAt, settingsJsonSchema, stripSecrets, unsetAt, updateConfigFile, updateUserSettings, userSettingsFile, validateConfigFile } from "./store";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("config-store");
});
afterEach(() => removeDir(home));

const settingsPath = () => join(home, "settings.json");
const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe("paths", () => {
  test("get and set walk objects and arrays, without touching the input", () => {
    const base = { a: { b: [{ c: 1 }] } };
    expect(getAt(base, "a.b.0.c")).toBe(1);
    expect(getAt(base, "a.x.y")).toBeUndefined();
    const next = setAt(base, "a.b.0.c", 2);
    expect(getAt(next, "a.b.0.c")).toBe(2);
    expect(base.a.b[0]!.c).toBe(1);
    expect(setAt({}, "x.y.z", true)).toEqual({ x: { y: { z: true } } });
    expect(unsetAt({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
  });
  test("prototype names and empty segments are refused", () => {
    expect(() => parsePath("a.__proto__.b")).toThrow();
    expect(() => parsePath("a..b")).toThrow();
    expect(() => setAt({}, "constructor.prototype.x", 1)).toThrow();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  test("setting under a scalar is an error", () => {
    expect(() => setAt({ a: 1 }, "a.b", 2)).toThrow(/not an object/);
  });
});

describe("updateUserSettings", () => {
  test("creates a missing file privately", async () => {
    const r = await updateUserSettings(home, { theme: "dark" });
    expect(r.changed).toBe(true);
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ theme: "dark" });
    expect(await mode(settingsPath())).toBe(0o600);
    expect(r.backup).toBeUndefined();
  });

  test("keeps unknown keys and validates with the layer schema", async () => {
    await writeFile(settingsPath(), JSON.stringify({ futureKey: { x: 1 }, theme: "light" }));
    await updateUserSettings(home, (d) => {
      d.effort = "high";
    });
    expect(await readUserSettingsRaw(home)).toEqual({ futureKey: { x: 1 }, theme: "light", effort: "high" });
  });

  test("an invalid result is refused with the issue path and nothing is written", async () => {
    await writeFile(settingsPath(), JSON.stringify({ theme: "light" }));
    const err = await updateUserSettings(home, { theme: "purple" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigStoreError);
    expect(err.issuePath).toBe("theme");
    expect(err.message).toContain("theme");
    expect(await readUserSettingsRaw(home)).toEqual({ theme: "light" });
    expect(await readdir(home)).toEqual(["settings.json"]);
  });

  test("never writes when nothing changed (no backup, same mtime)", async () => {
    await writeFile(settingsPath(), JSON.stringify({ theme: "light" }));
    const before = (await stat(settingsPath())).mtimeMs;
    const r = await updateUserSettings(home, { theme: "light" });
    expect(r.changed).toBe(false);
    expect((await stat(settingsPath())).mtimeMs).toBe(before);
    expect(await readdir(home)).toEqual(["settings.json"]);
    // key order does not count as a change either
    await writeFile(settingsPath(), '{"theme":"light","effort":"high"}');
    expect((await updateUserSettings(home, (d) => ({ effort: d.effort, theme: d.theme }))).changed).toBe(false);
  });

  test("an empty update to a missing file writes nothing", async () => {
    expect((await updateUserSettings(home, {})).changed).toBe(false);
    expect(await readdir(home)).toEqual([]);
  });

  test("rotates five backups, newest in .bak, and keeps them private", async () => {
    await updateUserSettings(home, { model: "m0" });
    for (let i = 1; i <= 7; i++) await updateUserSettings(home, { model: `m${i}` });
    const names = (await readdir(home)).sort();
    expect(names).toEqual(["settings.json", "settings.json.bak", "settings.json.bak.1", "settings.json.bak.2", "settings.json.bak.3", "settings.json.bak.4"]);
    const model = async (n: string) => JSON.parse(await readFile(join(home, n), "utf8")).model;
    expect(await model("settings.json")).toBe("m7");
    expect(await model("settings.json.bak")).toBe("m6");
    expect(await model("settings.json.bak.4")).toBe("m2");
    expect(await mode(join(home, "settings.json.bak"))).toBe(0o600);
  });

  test("patch semantics: objects merge, arrays replace, undefined deletes", async () => {
    await writeFile(settingsPath(), JSON.stringify({ permissions: { allow: ["a"], deny: ["z"] }, theme: "dark" }));
    await updateUserSettings(home, { permissions: { allow: ["b"] }, theme: undefined });
    expect(await readUserSettingsRaw(home)).toEqual({ permissions: { allow: ["b"], deny: ["z"] } });
  });

  test("serialises concurrent updates so none is lost", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => updateUserSettings(home, (d) => void (d.env = { ...(d.env as object), [`K${i}`]: "v" }))));
    expect(Object.keys((await readUserSettingsRaw(home)).env as object).length).toBe(8);
  });

  test("a file that is not JSON is an error naming it, and is not overwritten", async () => {
    await writeFile(settingsPath(), "{nope");
    await expect(updateUserSettings(home, { theme: "dark" })).rejects.toThrow(settingsPath());
    expect(await readFile(settingsPath(), "utf8")).toBe("{nope");
  });

  test("tightens a loose file mode on write", async () => {
    await writeFile(settingsPath(), "{}");
    await chmod(settingsPath(), 0o644);
    await updateUserSettings(home, { theme: "dark" });
    expect(await mode(settingsPath())).toBe(0o600);
  });
});

describe("gateway descriptor", () => {
  test("the same implementation validates gateway.json", async () => {
    const file = gatewayFile(home);
    await updateConfigFile(file, { sandbox: { network: "bridge" }, idleMinutes: 10 });
    expect(JSON.parse(await readFile(join(home, "gateway.json"), "utf8"))).toEqual({ sandbox: { network: "bridge" }, idleMinutes: 10 });
    const err = await updateConfigFile(file, { sandbox: { network: "host" } }).catch((e) => e);
    expect(err.issuePath).toBe("sandbox.network");
    expect(await validateConfigFile(file)).toBeUndefined();
  });
});

describe("validateConfigFile and schema", () => {
  test("reports the reason for a bad file, nothing for a missing one", async () => {
    expect(await validateConfigFile(userSettingsFile(home))).toBeUndefined();
    await writeFile(settingsPath(), JSON.stringify({ effort: 5 }));
    expect(await validateConfigFile(userSettingsFile(home))).toContain("effort");
  });
  test("JSON Schema describes the settings", () => {
    const schema = settingsJsonSchema() as { type: string; properties: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toContain("theme");
    expect(Object.keys((jsonSchemaOf(gatewayFile(home)) as { properties: object }).properties)).toContain("sandbox");
  });
});

describe("redact", () => {
  test("masks secret-looking keys and values at any depth, leaves the rest", () => {
    const out = redact({
      theme: "dark",
      telegram: { botToken: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789" },
      env: { OPENAI_API_KEY: "abc", PATH_HINT: "/bin" },
      providers: { x: { apiKey: "k", baseURL: "https://x" } },
      mcpServers: { s: { headers: { Authorization: "Bearer zzz" } } },
      note: "sk-live-1234",
      list: [{ password: "p" }],
      empty: { token: "" },
    });
    expect(out).toEqual({
      theme: "dark",
      telegram: { botToken: "********" },
      env: { OPENAI_API_KEY: "********", PATH_HINT: "/bin" },
      providers: { x: { apiKey: "********", baseURL: "https://x" } },
      mcpServers: { s: { headers: { Authorization: "********" } } },
      note: "********",
      list: [{ password: "********" }],
      empty: { token: "" },
    });
  });
  test("every value under mcpServers.*.env and .headers is masked, whatever its name or shape", () => {
    const out = redact({
      mcpServers: {
        a: { command: "x", args: ["--token", "t"], env: { DEBUG_LEVEL: "verbose", REGION: "eu", EMPTY: "" }, cwd: "/work" },
        b: { type: "http", url: "https://mcp.example/x", headers: { "X-Org": "acme", "X-Plain": "1" } },
      },
      env: { HARMLESS: "yes" },
      providers: { p: { apiKey: "k", api_key: "k2", key: "k3", baseURL: "https://p.example", name: "P" } },
    });
    expect(out).toEqual({
      mcpServers: {
        a: { command: "x", args: ["--token", "t"], env: { DEBUG_LEVEL: "********", REGION: "********", EMPTY: "" }, cwd: "/work" },
        b: { type: "http", url: "https://mcp.example/x", headers: { "X-Org": "********", "X-Plain": "********" } },
      },
      env: { HARMLESS: "yes" },
      providers: { p: { apiKey: "********", api_key: "********", key: "********", baseURL: "https://p.example", name: "P" } },
    });
  });
  test("redactAt knows the whole path, so a single value under mcpServers env is masked", () => {
    expect(redactAt("mcpServers.a.env.REGION", "eu")).toBe("********");
    expect(redactAt("mcpServers.a.headers.X-Org", "acme")).toBe("********");
    expect(redactAt("mcpServers.a.env", { REGION: "eu" })).toEqual({ REGION: "********" });
    expect(redactAt("mcpServers.a.command", "x")).toBe("x");
    expect(redactAt("env.REGION", "eu")).toBe("eu");
  });
  test("redactAt masks by the last path segment", () => {
    expect(redactAt("telegram.botToken", "x")).toBe("********");
    expect(redactAt("theme", "dark")).toBe("dark");
  });
});

test("stripSecrets drops an MCP server's whole env and headers, whatever the keys are called", () => {
  const stripped: unknown = stripSecrets({
    model: "m",
    mcpServers: { db: { type: "stdio", command: "db-mcp", env: { DATABASE_URL: "postgres://u:p@h/db", MODE: "ro" } }, api: { type: "http", url: "https://x", headers: { "X-Org": "acme" } } },
  });
  expect(stripped).toEqual({ model: "m", mcpServers: { db: { type: "stdio", command: "db-mcp" }, api: { type: "http", url: "https://x" } } });
});
