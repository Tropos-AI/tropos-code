// src/gateway/launchd.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { LAUNCHD_LABEL, LaunchdError, agentEnv, agentStatus, installAgent, plistPath, programArguments, renderPlist, uninstallAgent, type Launchctl } from "./launchd";

let userHome: string;
beforeEach(async () => {
  userHome = await makeTmpDir("gateway-launchd");
});
afterEach(async () => {
  await removeDir(userHome);
});

const options = (over: Partial<Parameters<typeof renderPlist>[0]> = {}) => ({
  programArguments: ["/Users/u/.local/bin/tcode", "gateway"],
  workingDirectory: "/Users/u",
  logPath: `${userHome}/.tropos/gateway/gateway.log`,
  env: { HOME: "/Users/u", PATH: "/usr/bin" },
  ...over,
});

describe("renderPlist", () => {
  test("starts at login, restarts on exit, and runs the given command", () => {
    const xml = renderPlist(options());
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<string>/Users/u/.local/bin/tcode</string>\n    <string>gateway</string>");
  });
  test("escapes XML in every value", () => {
    const xml = renderPlist(options({ workingDirectory: "/a&b/<c>", env: { X: 'a"b' } }));
    expect(xml).toContain("/a&amp;b/&lt;c&gt;");
    expect(xml).toContain("a&quot;b");
    expect(xml).not.toContain("<c>");
  });
});

describe("programArguments", () => {
  test("a compiled tcode is its own executable; from source the script comes along", () => {
    expect(programArguments("/home/u/.local/bin/tcode", "/x/src/index.ts")).toEqual(["/home/u/.local/bin/tcode", "gateway"]);
    expect(programArguments("/opt/bun", "/x/src/index.ts")).toEqual(["/opt/bun", "/x/src/index.ts", "gateway"]);
  });
});

describe("agentEnv", () => {
  test("a bare launchd environment gets a PATH that finds Docker, and never a token", () => {
    const env = agentEnv({ TROPOS_HOME: "/data", TROPOS_TELEGRAM_BOT_TOKEN: "123:secret", ANTHROPIC_API_KEY: "k" }, "/Users/u");
    expect(env.PATH).toContain("/usr/local/bin");
    expect(env.TROPOS_HOME).toBe("/data");
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(JSON.stringify(env)).not.toContain("ANTHROPIC");
  });
});

describe("install, status, uninstall", () => {
  const recorder = (code = 0, output = ""): Launchctl & { calls: string[][] } => {
    const calls: string[][] = [];
    const fn = (async (args: string[]) => {
      calls.push(args);
      return { code, output };
    }) as Launchctl & { calls: string[][] };
    fn.calls = calls;
    return fn;
  };
  const deps = (launchctl: Launchctl) => ({ platform: "darwin" as const, userHome, uid: 501, launchctl, sleep: async () => {} });

  test("install writes the plist, replaces a loaded copy and bootstraps it", async () => {
    const calls: string[][] = [];
    const launchctl: Launchctl = async (args) => {
      calls.push(args);
      return args[0] === "print" ? { code: 113, output: "" } : { code: 0, output: "" };
    };
    const { plist } = await installAgent(options(), deps(launchctl));
    expect(plist).toBe(plistPath(userHome));
    expect(readFileSync(plist, "utf8")).toContain("ProgramArguments");
    expect(calls).toEqual([
      ["bootout", `gui/501/${LAUNCHD_LABEL}`],
      ["print", `gui/501/${LAUNCHD_LABEL}`],
      ["bootstrap", "gui/501", plist],
    ]);
  });

  test("a failing bootstrap is an error that says why", async () => {
    const calls: string[][] = [];
    const launchctl: Launchctl = async (args) => {
      calls.push(args);
      return args[0] === "bootstrap" ? { code: 5, output: "Bootstrap failed: 5: Input/output error" } : { code: 0, output: "" };
    };
    await expect(installAgent(options(), deps(launchctl))).rejects.toThrow(/Input\/output error/);
  });

  test("uninstall unloads and removes the plist", async () => {
    const launchctl = recorder();
    await installAgent(options(), deps(launchctl));
    expect(await uninstallAgent(deps(launchctl))).toEqual({ removed: true });
    expect(existsSync(plistPath(userHome))).toBe(false);
  });

  test("status reads the pid from launchctl print", async () => {
    expect(await agentStatus(deps(recorder(0, "state = running\n\tpid = 4242\n")))).toEqual({ loaded: true, running: true, pid: 4242 });
    expect(await agentStatus(deps(recorder(0, "state = waiting")))).toEqual({ loaded: true, running: false });
    expect(await agentStatus(deps(recorder(113, "Could not find service")))).toEqual({ loaded: false, running: false });
  });

  test("anywhere but macOS it says so instead of failing oddly", async () => {
    await expect(installAgent(options(), { platform: "linux", userHome, uid: 1000 })).rejects.toThrow(LaunchdError);
  });
});
