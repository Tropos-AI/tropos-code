// src/install/commands.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { makeEngineFixture, type EngineFixture } from "../../test/install/helpers/engine";
import { runInstallCommand, oneTimeInstallNotice, type CommandContext } from "./commands";
import { versionPath } from "./layout";

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

describe("oneTimeInstallNotice (spec §11)", () => {
  test.each([
    ["stable", { autoUpdates: true, autoUpdatesChannel: "latest" }, `Background updates follow the 'latest' channel and may move you to a newer version. To stay on 'stable', set "autoUpdatesChannel": "stable" in ~/.tropos/settings.json.`],
    ["1.2.3", { autoUpdates: true, autoUpdatesChannel: "latest" }, `Background updates follow the 'latest' channel and may move you to a newer version. To stay on 1.2.3, set "autoUpdates": false in ~/.tropos/settings.json.`],
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
    expect(out.join("")).toStartWith("Usage: tropos rollback");
  });

  test("not a native install: exit 73 (R1.4)", async () => {
    f = await makeEngineFixture();
    const { c, err } = ctx({ execPath: "/usr/local/bin/bun" });
    for (const cmd of [{ kind: "update", background: false, alias: "update" }, { kind: "rollback" }, { kind: "install", force: false }] as const) {
      expect(await runInstallCommand(cmd, c)).toBe(73);
    }
    expect(err.join("")).toContain("not a native install; install with install.sh");
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
    expect(out.join("")).toContain("Tropos Code 1.1.0 is available but skipped because you rolled back from it; install it with tropos install 1.1.0.");
    f.srv.put("channels", "latest", "<html>");
    f.srv.put("channels", "latest.bak", "<html>");
    expect(await runInstallCommand({ kind: "install", target: "latest", force: false }, c)).toBe(69);
    expect(err.join("")).toContain("cannot resolve the latest channel");
  });
});
