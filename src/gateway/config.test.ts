// src/gateway/config.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { GatewayConfigError, configPermissionWarning, gatewayConfigPath, gatewayConfigSchema, loadGatewayConfig, newProjectsDirOf, proactiveEnabled, saveGatewayConfig, telegramToken } from "./config";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("gateway-config");
});
afterEach(async () => {
  await removeDir(home);
});

describe("loadGatewayConfig", () => {
  test("a missing file is the defaults: closed network, small sandbox, host chats at balanced", async () => {
    const config = await loadGatewayConfig(home);
    expect(config.chat).toEqual({ autonomy: "balanced", backend: "host" });
    expect(config.sandbox).toEqual({ image: "alpine:3.22", network: "none", memory: "1g", cpus: "2" });
    expect(config.idleMinutes).toBe(30);
    expect(config.projects).toEqual([]);
    expect(config.defaultProject).toBe("default");
  });
  test("reads what was saved, privately", async () => {
    await saveGatewayConfig(home, { ...(await loadGatewayConfig(home)), projects: [{ id: "app", name: "App", path: "/work/app" }], defaultProject: "app", telegram: { botToken: "123:abc" } });
    const config = await loadGatewayConfig(home);
    expect(config.projects).toEqual([{ id: "app", name: "App", path: "/work/app" }]);
    expect(config.defaultProject).toBe("app");
    expect(config.telegram.botToken).toBe("123:abc");
    if (process.platform !== "win32") expect((await stat(gatewayConfigPath(home))).mode & 0o777).toBe(0o600);
  });
  test("an old file with a workspace key becomes a project and the default, and the key is gone after a save", async () => {
    await writeFile(gatewayConfigPath(home), JSON.stringify({ workspace: "/work/My App", idleMinutes: 5 }));
    const config = await loadGatewayConfig(home);
    expect(config.projects).toEqual([{ id: "my-app", name: "My App", path: "/work/My App" }]);
    expect(config.defaultProject).toBe("my-app");
    expect(config.idleMinutes).toBe(5);
    expect("workspace" in config).toBe(false);
    await saveGatewayConfig(home, config);
    expect(JSON.parse(await Bun.file(gatewayConfigPath(home)).text()).workspace).toBeUndefined();
  });
  test("a workspace already listed as a project isn't added twice, and an explicit default is kept", async () => {
    await writeFile(
      gatewayConfigPath(home),
      JSON.stringify({ workspace: "/w/a", projects: [{ id: "a", name: "A", path: "/w/a" }], defaultProject: "default" }),
    );
    const config = await loadGatewayConfig(home);
    expect(config.projects).toHaveLength(1);
    expect(config.defaultProject).toBe("default");
  });
  test("a legacy workspace named like a reserved id gets another id", async () => {
    await writeFile(gatewayConfigPath(home), JSON.stringify({ workspace: "/w/default" }));
    expect((await loadGatewayConfig(home)).projects[0]?.id).toBe("default-2");
  });
  test("invalid JSON and invalid values are errors that name the file", async () => {
    await writeFile(gatewayConfigPath(home), "{nope");
    await expect(loadGatewayConfig(home)).rejects.toThrow(GatewayConfigError);
    await writeFile(gatewayConfigPath(home), JSON.stringify({ sandbox: { network: "host" } }));
    await expect(loadGatewayConfig(home)).rejects.toThrow(/sandbox\.network/);
  });
});

describe("telegramToken", () => {
  test("the environment wins over the file", async () => {
    const config = { ...(await loadGatewayConfig(home)), telegram: { botToken: "from-file" } };
    expect(telegramToken(config, { TROPOS_TELEGRAM_BOT_TOKEN: " from-env " })).toBe("from-env");
    expect(telegramToken(config, {})).toBe("from-file");
    expect(telegramToken(await loadGatewayConfig(home), {})).toBeUndefined();
  });
});

describe("configPermissionWarning", () => {
  test.skipIf(process.platform === "win32")("warns about a file other users can read", async () => {
    expect(await configPermissionWarning(home)).toBeUndefined();
    await writeFile(gatewayConfigPath(home), "{}");
    await chmod(gatewayConfigPath(home), 0o644);
    expect(await configPermissionWarning(home)).toContain("chmod 600");
    await chmod(gatewayConfigPath(home), 0o600);
    expect(await configPermissionWarning(home)).toBeUndefined();
  });

  const APPROVED = JSON.stringify({ version: 2, approved: [{ channel: "telegram", senderId: "7", approvedAt: 1 }] });
  const EXISTING = { autonomy: "ask", backend: "docker" } as const;
  test("a file without chat on an install with an approved sender is an existing install: ask and docker, until the user changes it", async () => {
    await mkdir(join(home, "gateway"), { recursive: true });
    await writeFile(join(home, "gateway", "pairing.json"), APPROVED);
    await writeFile(gatewayConfigPath(home), JSON.stringify({ idleMinutes: 5 }));
    expect((await loadGatewayConfig(home)).chat).toEqual(EXISTING);
  });
  test("no gateway.json but a pairing file with an approved sender (token from the environment) is an existing install too", async () => {
    await mkdir(join(home, "gateway"), { recursive: true });
    await writeFile(join(home, "gateway", "pairing.json"), APPROVED);
    expect((await loadGatewayConfig(home)).chat).toMatchObject(EXISTING);
  });
  test("setup finished before (onboarding.json has dismissedAt) is an existing install", async () => {
    await writeFile(join(home, "onboarding.json"), JSON.stringify({ dismissedAt: "2026-10-01T00:00:00.000Z" }));
    await writeFile(gatewayConfigPath(home), JSON.stringify({ idleMinutes: 5 }));
    expect((await loadGatewayConfig(home)).chat).toEqual(EXISTING);
  });
  test("a scheduled job already on disk makes an install existing", async () => {
    await mkdir(join(home, "gateway", "cron"), { recursive: true });
    await writeFile(join(home, "gateway", "cron", "jobs.json"), JSON.stringify({ jobs: [{ id: "a" }] }));
    expect((await loadGatewayConfig(home)).chat).toEqual(EXISTING);
  });
  test("an empty job list does not", async () => {
    await mkdir(join(home, "gateway", "cron"), { recursive: true });
    await writeFile(join(home, "gateway", "cron", "jobs.json"), JSON.stringify({ jobs: [] }));
    expect((await loadGatewayConfig(home)).chat.autonomy).toBe("balanced");
  });
  test("a bot token in gateway.json makes an install existing", async () => {
    await writeFile(gatewayConfigPath(home), JSON.stringify({ telegram: { botToken: "1:a" } }));
    expect((await loadGatewayConfig(home)).chat).toEqual(EXISTING);
  });
  test("a fresh install whose gateway.json the projects step wrote, with no pairing and no finished setup, is balanced/host", async () => {
    await writeFile(gatewayConfigPath(home), JSON.stringify({ projects: [{ id: "app", name: "app", path: "/w/app" }] }));
    expect((await loadGatewayConfig(home)).chat).toEqual({ autonomy: "balanced", backend: "host" });
  });
  test("a file that has chat keeps it, whatever the install", async () => {
    await mkdir(join(home, "gateway"), { recursive: true });
    await writeFile(join(home, "gateway", "pairing.json"), APPROVED);
    await writeFile(gatewayConfigPath(home), JSON.stringify({ chat: { autonomy: "autonomous", backend: "host" } }));
    expect((await loadGatewayConfig(home)).chat).toEqual({ autonomy: "autonomous", backend: "host" });
  });
  test("projects keep autonomy and pinned tests", async () => {
    const base = await loadGatewayConfig(home);
    await saveGatewayConfig(home, { ...base, projects: [{ id: "app", name: "app", path: "/w/app", autonomy: "autonomous", testCommands: ["bun test"] }] });
    expect((await loadGatewayConfig(home)).projects[0]).toEqual({ id: "app", name: "app", path: "/w/app", autonomy: "autonomous", testCommands: ["bun test"] });
  });
});

describe("remoteAccess", () => {
  test("defaults to off, and round-trips a saved tailnet address", async () => {
    expect((await loadGatewayConfig(home)).remoteAccess).toEqual({ tailscale: false });
    const config = await loadGatewayConfig(home);
    await saveGatewayConfig(home, { ...config, remoteAccess: { tailscale: true, httpsPort: 8443, hostname: "mac.tail1234.ts.net" } });
    expect((await loadGatewayConfig(home)).remoteAccess).toEqual({ tailscale: true, httpsPort: 8443, hostname: "mac.tail1234.ts.net" });
  });
});

describe("proactive and new-project settings", () => {
  test("proactive defaults; enabled unset follows Telegram", async () => {
    const c = await loadGatewayConfig(home);
    expect(c.proactive).toEqual({ activeHours: { start: "09:00", end: "21:00" }, everyHours: 4, maxPerDay: 1 });
    expect(proactiveEnabled(c, false)).toBe(false);
    expect(proactiveEnabled(c, true)).toBe(true);
    expect(proactiveEnabled({ ...c, proactive: { ...c.proactive, enabled: false } }, true)).toBe(false);
    expect(c.removedProjectPaths).toEqual([]);
  });
  test("bad proactive values are refused naming the key", async () => {
    await writeFile(gatewayConfigPath(home), JSON.stringify({ proactive: { activeHours: { start: "25:00", end: "21:00" } } }));
    await expect(loadGatewayConfig(home)).rejects.toThrow("proactive.activeHours.start");
  });
  test("newProjectsDir defaults to ~/Projects and expands ~", () => {
    const base = gatewayConfigSchema.parse({});
    expect(newProjectsDirOf(base, "/u")).toBe("/u/Projects");
    expect(newProjectsDirOf({ ...base, newProjectsDir: "~/Code" }, "/u")).toBe("/u/Code");
  });
});
