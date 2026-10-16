// src/gateway/config.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, stat, writeFile } from "node:fs/promises";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { GatewayConfigError, configPermissionWarning, gatewayConfigPath, loadGatewayConfig, saveGatewayConfig, telegramToken } from "./config";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("gateway-config");
});
afterEach(async () => {
  await removeDir(home);
});

describe("loadGatewayConfig", () => {
  test("a missing file is the defaults: closed network, small sandbox", async () => {
    const config = await loadGatewayConfig(home);
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
});
