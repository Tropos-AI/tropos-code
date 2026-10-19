// src/service/service.test.ts — both managers against a fake command runner: nothing real runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { serviceManager } from "./index";
import { plistPath } from "./launchd";
import { SYSTEMD_UNIT, renderUnit, unitPath } from "./systemd";
import type { RunResult, ServiceSpec } from "./types";

let userHome: string;
beforeEach(async () => {
  userHome = await makeTmpDir("service");
});
afterEach(() => removeDir(userHome));

const spec = (over: Partial<ServiceSpec> = {}): ServiceSpec => ({
  programArguments: ["/bin/tcode", "gateway"],
  workingDirectory: join(userHome, ".tropos"),
  logPath: join(userHome, ".tropos", "gateway", "gateway.log"),
  env: { HOME: userHome, PATH: "/usr/bin" },
  ...over,
});

/** Records every command; `answers` maps a command prefix to its result (default: success, no output). */
function fakeRunner(answers: Record<string, Partial<RunResult> | ((n: number) => Partial<RunResult>)> = {}) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const run = async (command: string[]): Promise<RunResult> => {
    const line = command.join(" ");
    calls.push(line);
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    const n = (counts.get(key ?? "") ?? 0) + 1;
    counts.set(key ?? "", n);
    const answer = key ? answers[key] : undefined;
    const value = typeof answer === "function" ? answer(n) : answer;
    return { code: 0, output: "", ...value };
  };
  return { run, calls };
}

describe("serviceManager", () => {
  test("picks the manager by platform", () => {
    expect(serviceManager({ platform: "darwin", userHome }).manager).toBe("launchd");
    expect(serviceManager({ platform: "linux", userHome }).manager).toBe("systemd");
    expect(serviceManager({ platform: "win32", userHome }).manager).toBe("none");
  });
  test("on an unsupported system install explains, and status says nothing is installed", async () => {
    const m = serviceManager({ platform: "win32", userHome });
    await expect(m.install(spec())).rejects.toThrow(/isn't supported/);
    await expect(m.start()).rejects.toThrow(/isn't supported/);
    expect(await m.status()).toEqual({ manager: "none", installed: false, running: false });
    expect(await m.uninstall()).toEqual({ removed: false });
  });
});

describe("launchd manager", () => {
  const make = (answers: Parameters<typeof fakeRunner>[0] = {}) => {
    const f = fakeRunner(answers);
    return { ...f, m: serviceManager({ platform: "darwin", userHome, uid: 501, run: f.run, sleep: async () => {} }) };
  };

  test("install writes the plist and bootstraps it; uninstall boots it out and removes it", async () => {
    const { m, calls } = make({ "launchctl print": { code: 113 } });
    const { unitPath: path } = await m.install(spec());
    expect(path).toBe(plistPath(userHome));
    expect(await readFile(path, "utf8")).toContain("<string>/bin/tcode</string>");
    expect(calls).toEqual(["launchctl bootout gui/501/com.troposlabs.gateway", "launchctl print gui/501/com.troposlabs.gateway", `launchctl bootstrap gui/501 ${path}`]);
    expect(await m.uninstall()).toEqual({ removed: true });
    expect(existsSync(path)).toBe(false);
    expect(await m.uninstall()).toEqual({ removed: false });
  });

  test("status reads the pid; stop boots out; start and restart load first when needed", async () => {
    const { m, calls } = make({ "launchctl print": { output: "pid = 77" } });
    await m.install(spec());
    expect(await m.status()).toMatchObject({ manager: "launchd", installed: true, running: true, pid: 77 });
    calls.length = 0;
    await m.restart();
    expect(calls).toEqual(["launchctl print gui/501/com.troposlabs.gateway", "launchctl kickstart -k gui/501/com.troposlabs.gateway"]);
    calls.length = 0;
    await m.stop();
    expect(calls[0]).toBe("launchctl bootout gui/501/com.troposlabs.gateway");
  });

  test("reinstalling a running service waits for launchd to unload it before loading it again", async () => {
    // bootout returns while the job is still going away; a bootstrap then fails with 5 and leaves nothing loaded.
    let gone = false;
    const { m, calls } = make({
      "launchctl bootout": () => ({ code: 0 }),
      "launchctl print": (n) => ((gone = n > 2) ? { code: 113 } : { output: "pid = 77" }),
      "launchctl bootstrap": () => (gone ? { code: 0 } : { code: 5, output: "Bootstrap failed: 5: Input/output error" }),
    });
    await m.install(spec());
    expect(calls.map((c) => c.split(" ")[1])).toEqual(["bootout", "print", "print", "print", "bootstrap"]);
  });

  test("a bootstrap that fails once while launchd settles is tried again", async () => {
    const { m, calls } = make({ "launchctl print": { code: 113 }, "launchctl bootstrap": (n) => (n === 1 ? { code: 5, output: "Input/output error" } : { code: 0 }) });
    await m.install(spec());
    expect(calls.filter((c) => c.includes("bootstrap"))).toHaveLength(2);
  });

  test("start after a stop bootstraps again, then kicks it", async () => {
    const { m, calls } = make({ "launchctl print": { code: 113 } });
    await m.install(spec());
    calls.length = 0;
    await m.start();
    expect(calls.map((c) => c.split(" ")[1])).toEqual(["print", "bootstrap", "kickstart"]);
  });

  test("start before install says to install", async () => {
    await expect(make().m.start()).rejects.toThrow(/tcode gateway install/);
  });

  test("under sudo it refuses and says to run it as yourself", async () => {
    const f = fakeRunner();
    const m = serviceManager({ platform: "darwin", userHome, uid: 0, run: f.run, sleep: async () => {} });
    await expect(m.install(spec())).rejects.toThrow(/without sudo/);
    expect(f.calls).toEqual([]);
  });

  test("a failed bootstrap is an error with launchctl's words", async () => {
    const { m } = make({ "launchctl bootstrap": { code: 5, output: "Input/output error" } });
    await expect(m.install(spec())).rejects.toThrow(/Input\/output error/);
  });
});

describe("systemd manager", () => {
  const make = (answers: Parameters<typeof fakeRunner>[0] = {}) => {
    const f = fakeRunner(answers);
    return { ...f, m: serviceManager({ platform: "linux", userHome, uid: 1000, user: "ana", run: f.run }) };
  };

  test("renderUnit restarts always, appends to the log and quotes what systemd would interpret", () => {
    const text = renderUnit(spec({ programArguments: ["/opt/my tools/tcode", "gateway", "100%", "$X"], env: { A: 'say "hi"' } }));
    expect(text).toContain('ExecStart="/opt/my tools/tcode" "gateway" "100%%" "$$X"');
    expect(text).toContain('Environment="A=say \\"hi\\""');
    expect(text).toContain("Restart=always");
    expect(text).toContain(`StandardOutput=append:${join(userHome, ".tropos", "gateway", "gateway.log")}`);
    expect(text).toContain(`StandardError=append:`);
    expect(text).toContain("WantedBy=default.target");
  });

  test("install writes the unit, reloads, enables it now and says how to enable lingering when it's off", async () => {
    const { m, calls } = make({ "systemctl --user is-active": { code: 3, output: "inactive" }, "loginctl show-user": { output: "Linger=no" } });
    const res = await m.install(spec());
    expect(res.unitPath).toBe(unitPath(userHome));
    expect(res.unitPath.endsWith(`.config/systemd/user/${SYSTEMD_UNIT}`)).toBe(true);
    expect(calls).toEqual([
      `systemctl --user is-active ${SYSTEMD_UNIT}`,
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
      "loginctl show-user ana -p Linger",
    ]);
    expect(res.hint).toContain("loginctl enable-linger ana");
  });

  test("no hint when lingering is on; a running copy is restarted to pick up the new unit", async () => {
    const { m, calls } = make({ "systemctl --user is-active": { output: "active" }, "loginctl show-user": { output: "Linger=yes" } });
    const res = await m.install(spec());
    expect(res.hint).toBeUndefined();
    expect(calls).toContain(`systemctl --user restart ${SYSTEMD_UNIT}`);
  });

  test("status: installed, active and the main pid", async () => {
    const { m } = make({ "systemctl --user is-active": { output: "active" }, "systemctl --user show": { output: "MainPID=4242" } });
    await m.install(spec());
    expect(await m.status()).toMatchObject({ manager: "systemd", installed: true, running: true, pid: 4242 });
  });

  test("status when stopped has no pid, and when never installed says so", async () => {
    const stopped = make({ "systemctl --user is-active": { code: 3, output: "inactive" } });
    expect(await stopped.m.status()).toMatchObject({ installed: false, running: false });
    expect((await stopped.m.status()).pid).toBeUndefined();
  });

  test("start, stop, restart need the unit; uninstall disables it now and removes the file", async () => {
    const { m, calls } = make();
    await expect(m.restart()).rejects.toThrow(/tcode gateway install/);
    await mkdir(join(userHome, ".config", "systemd", "user"), { recursive: true });
    await m.install(spec());
    calls.length = 0;
    await m.start();
    await m.stop();
    await m.restart();
    expect(calls).toEqual([`systemctl --user start ${SYSTEMD_UNIT}`, `systemctl --user stop ${SYSTEMD_UNIT}`, `systemctl --user restart ${SYSTEMD_UNIT}`]);
    calls.length = 0;
    expect(await m.uninstall()).toEqual({ removed: true });
    expect(calls).toEqual([`systemctl --user disable --now ${SYSTEMD_UNIT}`, "systemctl --user daemon-reload"]);
    expect(existsSync(unitPath(userHome))).toBe(false);
    expect(await m.uninstall()).toEqual({ removed: false });
  });

  test("a failing systemctl surfaces its message", async () => {
    const { m } = make({ "systemctl --user enable": { code: 1, output: "Failed to connect to bus" } });
    await expect(m.install(spec())).rejects.toThrow(/Failed to connect to bus/);
  });
});
