// src/gateway/commands.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { GatewayCommand } from "../cli/args";
import { gatewayDir, gatewayLogPath, loadGatewayConfig } from "./config";
import { installService, runGatewayCommand, type GatewayCommandContext } from "./commands";
import { plistPath } from "./launchd";
import { unitPath } from "../service/systemd";
import type { RunResult } from "../service/types";
import { getProject, listProjects } from "./projects";
import { FilePairing } from "./pairing";

let dir: string;
let home: string;
let userHome: string;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-commands");
  home = join(dir, "tropos");
  userHome = join(dir, "user");
  await mkdir(userHome, { recursive: true });
  await mkdir(join(dir, "work", "proj"), { recursive: true });
  await mkdir(join(dir, "work", "app"), { recursive: true });
});
afterEach(() => removeDir(dir));

async function run(command: GatewayCommand, over: Partial<GatewayCommandContext> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  let loaded = true;
  const run: (command: string[]) => Promise<RunResult> = async (command) => {
    // Nothing real runs: launchctl, systemctl and loginctl are all this fake.
    const [tool, ...args] = command;
    calls.push(tool === "launchctl" ? args : command);
    if (tool === "launchctl") {
      if (args[0] === "bootout") loaded = false;
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "print") return loaded ? { code: 0, output: "pid = 77" } : { code: 113, output: "" };
      return { code: 0, output: "" };
    }
    if (command[2] === "is-active") return { code: 0, output: "active" };
    if (command[2] === "show") return { code: 0, output: "MainPID=99" };
    return { code: 0, output: "" };
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
    run,
    git: async () => {},
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
  test("install needs no workspace: it creates the default project, writes the plist for the Tropos home and loads it", async () => {
    const res = await run({ kind: "gateway-install" });
    expect(res.code).toBe(0);
    expect(existsSync(join(home, "workspace"))).toBe(true);
    expect(existsSync(plistPath(userHome))).toBe(true);
    const plist = await Bun.file(plistPath(userHome)).text();
    expect(plist).toContain("<string>/bin/tcode</string>\n    <string>gateway</string>");
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${home}</string>`);
    expect(res.calls.map((c) => c[0])).toEqual(["bootout", "print", "bootstrap"]);
    expect(res.out).toContain("No Telegram bot yet: ask me to connect Telegram (paste the token from @BotFather), or open http://127.0.0.1:4317/#/settings.");
    expect(res.out).toContain("Running tcode in a git repo adds it; or ask me to add one.");
    expect(res.out).not.toContain("tcode projects add");
    expect(res.out).not.toContain("gateway.json");
    expect((await loadGatewayConfig(home)).projects).toEqual([]);
  });

  test("--workspace adds that directory as a project and makes it the default", async () => {
    const res = await run({ kind: "gateway-install", workspace: "proj" });
    expect(res.code).toBe(0);
    const project = await getProject(home, "proj");
    expect(project?.path).toBe(join(dir, "work", "proj"));
    expect((await loadGatewayConfig(home)).defaultProject).toBe("proj");
    // Again with the same directory: reused, not a duplicate and not an error.
    expect((await run({ kind: "gateway-install", workspace: "proj" })).code).toBe(0);
    expect((await listProjects(home)).map((p) => p.id)).toEqual(["default", "proj"]);
  });

  test("install doesn't nag when a token is set, and never writes it into the plist", async () => {
    const res = await run({ kind: "gateway-install" }, { env: { TROPOS_HOME: home, TROPOS_TELEGRAM_BOT_TOKEN: "123:secret" } });
    expect(res.out).not.toContain("No Telegram bot yet");
    expect(await Bun.file(plistPath(userHome)).text()).not.toContain("secret");
  });

  test("start, stop and restart go through the service, and say to install first", async () => {
    expect((await run({ kind: "gateway-restart" })).err).toContain("tcode gateway install");
    await run({ kind: "gateway-install" });
    const restart = await run({ kind: "gateway-restart" });
    expect(restart.out).toContain("restarted");
    expect(restart.calls.some((c) => c[0] === "kickstart" && c[1] === "-k")).toBe(true);
    expect((await run({ kind: "gateway-stop" })).calls.map((c) => c[0])).toContain("bootout");
    expect((await run({ kind: "gateway-start" })).out).toContain("started");
  });

  test("uninstall says whether anything was installed", async () => {
    expect((await run({ kind: "gateway-uninstall" })).out).toContain("wasn't installed");
    await run({ kind: "gateway-install" });
    expect((await run({ kind: "gateway-uninstall" })).out).toContain("stopped and removed");
  });

  test("install refuses a --workspace that would put the home directory or ~/.tropos in the container", async () => {
    await mkdir(home, { recursive: true });
    for (const workspace of [userHome, home, dir]) {
      const res = await run({ kind: "gateway-install", workspace });
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/home directory|data directory/);
    }
    expect(existsSync(plistPath(userHome))).toBe(false);
  });

  test("on Linux install writes a systemd user unit and prints the lingering hint", async () => {
    const res = await run({ kind: "gateway-install" }, { platform: "linux" });
    expect(res.code).toBe(0);
    expect(existsSync(unitPath(userHome))).toBe(true);
    expect(await Bun.file(unitPath(userHome)).text()).toContain(`WorkingDirectory=${home}`);
    expect(res.calls.map((c) => c.slice(0, 3).join(" "))).toContain("systemctl --user daemon-reload");
  });

  test("on a system with no service manager, install explains instead of failing oddly", async () => {
    const res = await run({ kind: "gateway-install" }, { platform: "win32" });
    expect(res.code).toBe(1);
    expect(res.err).toContain("isn't supported");
  });
});

describe("installService", () => {
  test("installs the unit for the given home and returns where it went; gateway install goes through it", async () => {
    const installs: string[][] = [];
    const service = {
      manager: "launchd" as const,
      install: async (spec: { programArguments: string[]; workingDirectory: string }) => (installs.push(spec.programArguments), { unitPath: "/u/x.plist", hint: "h" }),
      uninstall: async () => ({ removed: false }),
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      status: async () => ({ manager: "launchd" as const, installed: false, running: false }),
    };
    const res = await installService({ home, env: { TROPOS_HOME: home }, execPath: "/bin/tcode", userHome, service, git: async () => {} });
    expect(res).toEqual({ unitPath: "/u/x.plist", hint: "h" });
    expect(installs).toEqual([["/bin/tcode", "gateway"]]);
    expect((await listProjects(home)).map((p) => p.id)).toEqual(["default"]);
    // The command prints what installService returned, from the real fake-runner path.
    const viaCommand = await run({ kind: "gateway-install" }, { service });
    expect(viaCommand.out).toContain("Gateway installed (/u/x.plist)");
    expect(installs).toHaveLength(2);
  });
});

describe("tcode projects", () => {
  test("list shows the built-in project first; add, default and remove change the registry", async () => {
    expect((await run({ kind: "projects-list" })).out).toMatch(/\* default\s+Default workspace/);

    const added = await run({ kind: "projects-add", path: "app", name: "My App" });
    expect(added.code).toBe(0);
    expect(added.out).toContain('"my-app"');
    expect((await run({ kind: "projects-add", path: "app" })).err).toContain("already the project");

    await run({ kind: "projects-default", id: "my-app" });
    expect((await run({ kind: "projects-list" })).out).toMatch(/\* my-app/);
    expect((await run({ kind: "projects-default", id: "ghost" })).code).toBe(1);

    expect((await run({ kind: "projects-remove", id: "default" })).err).toContain("built in");
    expect((await run({ kind: "projects-remove", id: "my-app" })).code).toBe(0);
    expect((await run({ kind: "projects-list" })).out).toMatch(/\* default/);
  });

  test("a directory that doesn't exist or holds the home directory is refused", async () => {
    expect((await run({ kind: "projects-add", path: "nope" })).err).toContain("doesn't exist");
    expect((await run({ kind: "projects-add", path: userHome })).err).toContain("home directory");
  });
});
