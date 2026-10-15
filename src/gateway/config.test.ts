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
    expect(config.workspace).toBeUndefined();
  });
  test("reads what was saved, privately", async () => {
    await saveGatewayConfig(home, { ...(await loadGatewayConfig(home)), workspace: "/work/app", telegram: { botToken: "123:abc" } });
    const config = await loadGatewayConfig(home);
    expect(config.workspace).toBe("/work/app");
    expect(config.telegram.botToken).toBe("123:abc");
    if (process.platform !== "win32") expect((await stat(gatewayConfigPath(home))).mode & 0o777).toBe(0o600);
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
