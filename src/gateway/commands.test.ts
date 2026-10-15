// src/gateway/commands.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { GatewayCommand } from "../cli/args";
import { gatewayDir, loadGatewayConfig } from "./config";
import { runGatewayCommand, type GatewayCommandContext } from "./commands";
import { plistPath, type Launchctl } from "./launchd";
import { FilePairing } from "./pairing";

let dir: string;
let home: string;
let userHome: string;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-commands");
  home = join(dir, "tropos");
  userHome = join(dir, "user");
  await mkdir(userHome, { recursive: true });
  await mkdir(join(dir, "work"), { recursive: true });
});
afterEach(() => removeDir(dir));

async function run(command: GatewayCommand, over: Partial<GatewayCommandContext> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const launchctl: Launchctl = async (args) => {
    calls.push(args);
    return { code: 0, output: args[0] === "print" ? "pid = 77" : "" };
  };
  const code = await runGatewayCommand(command, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { TROPOS_HOME: home },
    cwd: join(dir, "work"),
    execPath: "/bin/tcode",
    userHome,
    uid: 501,
    platform: "darwin",
    launchctl,
    ...over,
  });
  return { code, out: out.join(""), err: err.join(""), calls };
}

describe("pairing", () => {
  test("a code the bot gave out is approved once, then the sender is listed and can be revoked", async () => {
    const pairing = new FilePairing({ path: join(gatewayDir(home), "pairing.json") });
    const challenge = await pairing.challenge("telegram", "42");
    if (challenge.kind !== "code") throw new Error("expected a code");

    const approved = await run({ kind: "pairing-approve", channel: "telegram", code: challenge.code });
    expect(approved.code).toBe(0);
    expect(approved.out).toContain("sender 42");
    expect((await run({ kind: "pairing-approve", channel: "telegram", code: challenge.code })).code).toBe(1);

    expect((await run({ kind: "pairing-list" })).out).toContain("telegram  42");
    expect((await run({ kind: "pairing-revoke", channel: "telegram", senderId: "42" })).code).toBe(0);
    expect((await run({ kind: "pairing-revoke", channel: "telegram", senderId: "42" })).code).toBe(1);
    expect((await run({ kind: "pairing-list" })).out).toContain("Nobody is approved");
  });

  test("a wrong code is refused with a reason", async () => {
    const res = await run({ kind: "pairing-approve", channel: "telegram", code: "NOPE2345" });
    expect(res.code).toBe(1);
    expect(res.err).toContain("tcode:");
  });
});

describe("gateway install / status / uninstall", () => {
  test("install records the workspace, writes the plist for it and loads it", async () => {
    const res = await run({ kind: "gateway-install", workspace: "proj" });
    expect(res.code).toBe(0);
    expect((await loadGatewayConfig(home)).workspace).toBe(join(dir, "work", "proj"));
    expect(existsSync(plistPath(userHome))).toBe(true);
    expect(res.calls.map((c) => c[0])).toEqual(["bootout", "bootstrap"]);
    expect(res.out).toContain("No Telegram bot token yet");
  });

  test("install doesn't nag when a token is set, and never writes it into the plist", async () => {
    const res = await run({ kind: "gateway-install" }, { env: { TROPOS_HOME: home, TROPOS_TELEGRAM_BOT_TOKEN: "123:secret" } });
    expect(res.out).not.toContain("No Telegram bot token");
    expect(await Bun.file(plistPath(userHome)).text()).not.toContain("secret");
  });

  test("status reports the launch agent, the process and the sandbox", async () => {
    const res = await run({ kind: "gateway-status" });
    expect(res.code).toBe(0);
    expect(res.out).toContain("running (pid 77)");
    expect(res.out).toContain("Process: not running");
    expect(res.out).toContain("network none");
  });

  test("uninstall says whether anything was installed", async () => {
    expect((await run({ kind: "gateway-uninstall" })).out).toContain("wasn't installed");
    await run({ kind: "gateway-install" });
    expect((await run({ kind: "gateway-uninstall" })).out).toContain("stopped and removed");
  });

  test("install refuses a workspace that would put the home directory or ~/.tropos in the container", async () => {
    for (const workspace of [userHome, home, dir]) {
      const res = await run({ kind: "gateway-install", workspace });
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/home directory|data directory/);
    }
    expect(existsSync(plistPath(userHome))).toBe(false);
  });

  test("off macOS, install explains instead of failing oddly", async () => {
    const res = await run({ kind: "gateway-install" }, { platform: "linux" });
    expect(res.code).toBe(1);
    expect(res.err).toContain("only macOS has");
  });
});
