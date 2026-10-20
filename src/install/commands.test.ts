// src/install/commands.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEngineFixture, type EngineFixture } from "../../test/install/helpers/engine";
import { runInstallCommand, oneTimeInstallNotice, type CommandContext } from "./commands";
import { makeTestKey } from "../../test/install/helpers/keys";
import { versionPath } from "./layout";
import { readLink } from "./link";
import { acquireInstallLock } from "./locks";

let f: EngineFixture;
afterEach(() => f?.close());

function ctx(overrides: Partial<CommandContext> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const c: CommandContext = {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    env: { HOME: f.home },
    execPath: versionPath(f.layout, "1.0.0"),
    version: "1.0.0",
    settings: { autoUpdates: true, autoUpdatesChannel: "latest" },
    engine: (log) => ({ ...f.deps, log }),
    ...overrides,
  };
  return { c, out, err };
}

describe("oneTimeInstallNotice", () => {
  test.each([
    ["stable", { autoUpdates: true, autoUpdatesChannel: "latest" }, `Background updates follow the 'latest' channel and may move you to a newer version. To stay on 'stable', switch the update channel to 'stable' in the dashboard (tcode dashboard).`],
    ["1.2.3", { autoUpdates: true, autoUpdatesChannel: "latest" }, `Background updates follow the 'latest' channel and may move you to a newer version. To stay on 1.2.3, turn background updates off in the dashboard (tcode dashboard).`],
    ["stable", { autoUpdates: true, autoUpdatesChannel: "stable" }, null],
    ["1.2.3", { autoUpdates: false, autoUpdatesChannel: "latest" }, null],
  ])("%s with %j", (target, settings, expected) => {
    expect(oneTimeInstallNotice(target, settings as CommandContext["settings"])).toBe(expected);
  });
});

describe("runInstallCommand", () => {
  test("help", async () => {
    f = await makeEngineFixture();
    const { c, out } = ctx();
    expect(await runInstallCommand({ kind: "help", command: "rollback" }, c)).toBe(0);
    expect(out.join("")).toStartWith("Usage: tcode rollback");
  });

  test("not a native install: exit 73", async () => {
    f = await makeEngineFixture();
    const { c, err } = ctx({ execPath: "/usr/local/bin/bun" });
    for (const cmd of [{ kind: "update", background: false, alias: "update" }, { kind: "rollback" }, { kind: "install", force: false }] as const) {
      expect(await runInstallCommand(cmd, c)).toBe(73);
    }
    expect(err.join("")).toContain("not a native install; install with install.sh");
  });

  test("a Homebrew install is updated with brew", async () => {
    f = await makeEngineFixture();
    const { c, err } = ctx({ execPath: "/opt/homebrew/Cellar/tcode/1.0.0/bin/tcode" });
    expect(await runInstallCommand({ kind: "update", background: false, alias: "update" }, c)).toBe(73);
    expect(err.join("")).toContain("installed with Homebrew; update it with: brew upgrade tcode");
    expect(await runInstallCommand({ kind: "rollback" }, c)).toBe(73);
    expect(err.join("")).toContain("Homebrew, which keeps no older version to go back to");
  });

  test("install-self runs from a temporary folder", async () => {
    f = await makeEngineFixture();
    const r = await f.release("1.0.0");
    const exe = join(f.root, "tropos-download");
    await writeFile(exe, r.binary);
    await chmod(exe, 0o700);
    await writeFile(join(f.root, "m.json"), r.verified.bytes);
    await writeFile(join(f.root, "m.sig"), r.verified.signature);
    const { c, out } = ctx({ execPath: exe });
    expect(await runInstallCommand({ kind: "install-self", manifest: join(f.root, "m.json"), signature: join(f.root, "m.sig") }, c)).toBe(0);
    expect(out.join("")).toContain("Installed Tropos Code 1.0.0.");
  });

  test("install, update, rollback messages and exit codes", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await f.direct("1.0.0");
    const { c, out, err } = ctx();
    expect(await runInstallCommand({ kind: "install", target: "1.0.0", force: false }, c)).toBe(0);
    f.srv.put("channels", "latest", "1.1.0\n");
    expect(await runInstallCommand({ kind: "update", background: false, alias: "update" }, c)).toBe(0);
    expect(out.join("")).toContain("Updated Tropos Code from 1.0.0 to 1.1.0.");
    expect(await runInstallCommand({ kind: "update", background: false, alias: "update" }, c)).toBe(0);
    expect(out.join("")).toContain("Tropos Code 1.1.0 is up to date (latest: 1.1.0).");
    expect(await runInstallCommand({ kind: "rollback" }, c)).toBe(0);
    expect(out.join("")).toContain("Rolled back from 1.1.0 to 1.0.0. Background updates will skip 1.1.0.");
    expect(await runInstallCommand({ kind: "update", background: false, alias: "update" }, c)).toBe(0);
    expect(out.join("")).toContain("Tropos Code 1.1.0 is available but skipped because you rolled back from it; install it with tcode install 1.1.0.");
    f.srv.put("channels", "latest", "<html>");
    f.srv.put("channels", "latest.bak", "<html>");
    expect(await runInstallCommand({ kind: "install", target: "latest", force: false }, c)).toBe(69);
    expect(err.join("")).toContain("cannot resolve the latest channel");
  });
});

describe("runInstallCommand exit codes and messages", () => {
  const bg = { kind: "update", background: true, alias: "update" } as const;
  const fg = { kind: "update", background: false, alias: "update" } as const;

  test("background update exits 0 and logs a timestamped line when the update fails", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.direct("1.0.0");
    f.srv.put("channels", "latest", "<html>");
    f.srv.put("channels", "latest.bak", "<html>");
    const { c, out, err } = ctx();
    expect(await runInstallCommand(bg, c)).toBe(0);
    expect(out.join("")).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z /m);
    expect(err.join("")).toBe("");
  });

  test("background update exits 0 when the engine factory throws", async () => {
    f = await makeEngineFixture();
    const { c, out } = ctx({ engine: () => { throw new Error("no layout"); } });
    expect(await runInstallCommand(bg, c)).toBe(0);
    expect(out.join("")).toMatch(/^\d{4}-.* failed: no layout/m);
  });

  test("integrity failure maps to 65", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    const other = await makeTestKey(f.root, "other");
    const { c, err } = ctx({ engine: (log) => ({ ...f.deps, log, trusted: other.trusted }) });
    expect(await runInstallCommand({ kind: "install", target: "1.0.0", force: false }, c)).toBe(65);
    expect(err.join("")).toStartWith("tcode: ");
  });

  test("a held install lock maps to 75", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    const held = await acquireInstallLock(f.layout, { wait: false, version: "x" });
    try {
      const { c } = ctx({ engine: (log) => ({ ...f.deps, log, lockTimeoutMs: 50 }) });
      expect(await runInstallCommand({ kind: "install", target: "1.0.0", force: false }, c)).toBe(75);
    } finally {
      held?.release();
    }
  });

  test("non-InstallError exits 1 with a clean message; a thrown string is shown as is", async () => {
    f = await makeEngineFixture();
    const a = ctx({ engine: () => { throw new TypeError("boom"); } });
    expect(await runInstallCommand({ kind: "rollback" }, a.c)).toBe(1);
    expect(a.err.join("")).toBe("tcode: boom\n");
    const b = ctx({ engine: () => { throw "plain failure"; } });
    expect(await runInstallCommand({ kind: "rollback" }, b.c)).toBe(1);
    expect(b.err.join("")).toBe("tcode: plain failure\n");
  });

  test("upgrade alias behaves like update", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.direct("1.0.0");
    const { c, out } = ctx();
    await runInstallCommand({ kind: "install", target: "1.0.0", force: false }, c);
    f.srv.put("channels", "latest", "1.0.0\n");
    expect(await runInstallCommand({ ...fg, alias: "upgrade" }, c)).toBe(0);
    expect(out.join("")).toContain("Tropos Code 1.0.0 is up to date (latest: 1.0.0).");
  });

  test("reinstalling the current version reports already installed", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.direct("1.0.0");
    const { c, out } = ctx();
    expect(await runInstallCommand({ kind: "install", target: "1.0.0", force: false }, c)).toBe(0);
    expect(await runInstallCommand({ kind: "install", target: "1.0.0", force: false }, c)).toBe(0);
    expect(out.join("")).toContain("Tropos Code 1.0.0 is already installed.");
  });
});

describe("commands hold the in-use lock of the version they run from", () => {
  test("install <current> --force on a damaged current, run from it: busy, file untouched, points to install.sh", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["0.9.0", "1.0.0"], current: "1.0.0", previous: "0.9.0", link: "1.0.0" });
    await appendFile(versionPath(f.layout, "1.0.0"), "damage");
    const damaged = await readFile(versionPath(f.layout, "1.0.0"));
    const { c, err } = ctx();
    expect(await runInstallCommand({ kind: "install", target: "1.0.0", force: true }, c)).toBe(75);
    expect(err.join("")).toContain("version 1.0.0 is damaged and this tcode is running from it");
    expect(err.join("")).toContain("reinstall it with install.sh");
    expect(await readFile(versionPath(f.layout, "1.0.0"))).toEqual(damaged);
    expect((await readdir(f.layout.versions)).filter((n) => n.startsWith("."))).toEqual([]);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "0.9.0" });
  });

  test("update run from a local build of the version it would install: busy, the running file stays", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["0.9.0"], current: "0.9.0", link: "0.9.0" });
    await f.release("1.0.0");
    await writeFile(versionPath(f.layout, "1.0.0"), "#!/bin/sh\necho local\n");
    await chmod(versionPath(f.layout, "1.0.0"), 0o755);
    f.srv.put("channels", "latest", "1.0.0\n");
    const { c, err } = ctx();
    expect(await runInstallCommand({ kind: "update", background: false, alias: "update" }, c)).toBe(75);
    expect(err.join("")).toContain("reinstall it with install.sh");
    expect(await readFile(versionPath(f.layout, "1.0.0"), "utf8")).toBe("#!/bin/sh\necho local\n");
    expect((await readdir(f.layout.versions)).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("a detached update --background never deletes the version it runs from in its cleanup", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0"], current: "1.3.0", previous: "1.2.0", link: "1.3.0" });
    await f.release("1.4.0");
    f.srv.put("channels", "latest", "1.4.0\n");
    const { c } = ctx();
    expect(await runInstallCommand({ kind: "update", background: true, alias: "update" }, c)).toBe(0);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.4.0" });
    expect((await readdir(f.layout.versions)).filter((n) => !n.startsWith(".")).sort()).toEqual(["1.0.0", "1.2.0", "1.3.0", "1.4.0"]);
  });
});

describe("after an update", () => {
  const bg = { kind: "update", background: true, alias: "update" } as const;
  const fg = { kind: "update", background: false, alias: "update" } as const;

  test("tcode update hands the new version to afterUpdate (the service restart) and prints its line; up to date does nothing", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await f.direct("1.0.0");
    f.srv.put("channels", "latest", "1.1.0\n");
    const calls: string[] = [];
    const { c, out } = ctx({ afterUpdate: async (v, o) => (calls.push(`${v}:${o.background}`), `Restarted the background service; it runs ${v} now.`) });
    expect(await runInstallCommand(fg, c)).toBe(0);
    expect(out.join("")).toContain(" to 1.1.0.\nRestarted the background service; it runs 1.1.0 now.\n");
    expect(await runInstallCommand(fg, c)).toBe(0);
    expect(calls).toEqual(["1.1.0:false"]);
  });

  test("a restart that fails is reported, and the update still counts", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await f.direct("1.0.0");
    f.srv.put("channels", "latest", "1.1.0\n");
    const { c, out, err } = ctx({ afterUpdate: async () => { throw new Error("launchctl kickstart failed: exit 5"); } });
    expect(await runInstallCommand(fg, c)).toBe(0);
    expect(out.join("")).toContain(" to 1.1.0.");
    expect(err.join("")).toContain("tcode: 1.1.0 is installed, but the background service could not be restarted: launchctl kickstart failed: exit 5. Restart it with: tcode gateway restart\n");
  });

  test("a background update that moved the version tells afterUpdate it was a background one; a failure there is only logged", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.3.0"], current: "1.3.0", previous: "1.0.0", link: "1.3.0" });
    await f.release("1.4.0");
    f.srv.put("channels", "latest", "1.4.0\n");
    const calls: string[] = [];
    const { c, out, err } = ctx({
      afterUpdate: async (v, o) => {
        calls.push(`${v}:${o.background}`);
        throw new Error("no gateway");
      },
    });
    expect(await runInstallCommand(bg, c)).toBe(0);
    expect(calls).toEqual(["1.4.0:true"]);
    expect(out.join("")).toMatch(/after the update: no gateway/);
    expect(err.join("")).toBe("");
  });
});

describe("recovery reporting", () => {
  test("recovery actions are printed even when the command then fails", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.0.0", link: "1.1.0" });
    f.srv.put("channels", "latest", "<html>");
    f.srv.put("channels", "latest.bak", "<html>");
    const { c, err } = ctx();
    expect(await runInstallCommand({ kind: "install", target: "latest", force: false }, c)).toBe(69);
    expect(err.join("")).toContain(`tcode: adopted 1.1.0, which ${f.layout.binLink} points to\n`);
  });

  test("install and update print the fatal recovery condition and carry on", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    await appendFile(versionPath(f.layout, "1.0.0"), "damage");
    await f.release("1.1.0");
    f.srv.put("channels", "latest", "1.1.0\n");
    const { c, out, err } = ctx();
    expect(await runInstallCommand({ kind: "update", background: false, alias: "update" }, c)).toBe(0);
    expect(err.join("")).toContain("tcode: no verified Tropos version is installed; reinstall with install.sh\n");
    expect(out.join("")).toContain("to 1.1.0.");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.1.0" });
  });

  test.each([
    ["rollback", { kind: "rollback" } as const],
    ["install --self", null],
  ])("%s says it is waiting for the install lock", async (_name, cmd) => {
    f = await makeEngineFixture();
    const r = await f.release("1.0.0");
    await f.direct("1.0.0");
    await writeFile(join(f.root, "m.json"), r.verified.bytes);
    await writeFile(join(f.root, "m.sig"), r.verified.signature);
    const held = (await acquireInstallLock(f.layout, { wait: false, version: "x" }))!;
    try {
      const { c, err } = ctx({ engine: (log) => ({ ...f.deps, log, lockTimeoutMs: 50 }) });
      const command = cmd ?? ({ kind: "install-self", manifest: join(f.root, "m.json"), signature: join(f.root, "m.sig") } as const);
      expect(await runInstallCommand(command, c)).toBe(75);
      expect(err.join("")).toContain("tcode: waiting for another Tropos install to finish");
    } finally {
      held.release();
    }
  });
});
