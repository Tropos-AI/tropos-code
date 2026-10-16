// src/cli/main.install.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEngineFixture, type EngineFixture } from "../../test/install/helpers/engine";
import { versionPath } from "../install/layout";
import { emptyState, writeState } from "../install/state";
import { main } from "./main";

let f: EngineFixture;
afterEach(() => f?.close());

async function run(argv: string[], execPath: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    env: { HOME: f.home, TROPOS_HOME: join(f.home, ".tropos"), SHELL: "/bin/bash" },
    cwd: f.root,
    execPath,
    engine: (log) => ({ ...f.deps, log }),
    readStdin: async () => null,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("main dispatches install subcommands (spec §12)", () => {
  test("a dev run refuses with 73", async () => {
    f = await makeEngineFixture();
    const r = await run(["update"], "/usr/local/bin/bun");
    expect(r.code).toBe(73);
  });

  test("-- update is a prompt, not a subcommand", async () => {
    f = await makeEngineFixture();
    const r = await run(["--", "update"], "/usr/local/bin/bun");
    expect(r.err).toContain("interactive mode needs a terminal");
  });

  test("install stable never changes settings and prints the notice (R9.1)", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.direct("1.0.0");
    f.srv.put("channels", "stable", "1.0.0\n");
    const settingsPath = join(f.home, ".tropos", "settings.json");
    await mkdir(join(f.home, ".tropos"), { recursive: true });
    const settingsText = '{\n  "autoUpdatesChannel": "latest"\n}\n';
    await writeFile(settingsPath, settingsText);
    const r = await run(["install", "stable"], versionPath(f.layout, "1.0.0"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("To stay on 'stable', switch the update channel to 'stable' in the dashboard (tcode dashboard).");
    expect(await readFile(settingsPath, "utf8")).toBe(settingsText);
  });

  test("install --help", async () => {
    f = await makeEngineFixture();
    const r = await run(["install", "--help"], "/usr/local/bin/bun");
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("Usage: tcode install");
  });
});

describe("corrupt settings.json", () => {
  async function corrupt() {
    f = await makeEngineFixture();
    await mkdir(join(f.home, ".tropos"), { recursive: true });
    await writeFile(join(f.home, ".tropos", "settings.json"), "{ not json");
  }

  test("install --help still works", async () => {
    await corrupt();
    expect((await run(["install", "--help"], "/usr/local/bin/bun")).code).toBe(0);
  });

  test("install --self reaches the command, not a settings error", async () => {
    await corrupt();
    const r = await run(["install", "--self", "--manifest", "/nope/m.json", "--signature", "/nope/m.sig"], "/usr/local/bin/bun");
    expect(r.err).not.toContain("settings");
  });

  test("rollback does not read settings", async () => {
    await corrupt();
    expect((await run(["rollback"], "/usr/local/bin/bun")).code).toBe(73);
  });

  test("update --background exits 0", async () => {
    await corrupt();
    expect((await run(["update", "--background"], "/usr/local/bin/bun")).code).toBe(0);
  });

  test("foreground update reports the settings error with exit 1", async () => {
    await corrupt();
    const r = await run(["update"], versionPath(f.layout, "1.0.0"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("settings");
  });
});

describe("main starts native sessions (spec 10.1, 11)", () => {
  async function session(execPath: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([], {
      out: (s) => void out.push(s),
      err: (s) => void err.push(s),
      env: { HOME: f.home, TROPOS_HOME: join(f.home, ".tropos"), SHELL: "/bin/bash" },
      cwd: f.root,
      execPath,
      readStdin: async () => null,
      tty: { stdin: true, stdout: true },
    });
    return { code, err: err.join(""), out: out.join("") };
  }

  test("re-executes through the link with TROPOS_REEXEC=1 when its binary was removed", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", link: "1.1.0" });
    await rm(versionPath(f.layout, "1.0.0"));
    await rm(f.layout.binLink);
    await writeFile(f.layout.binLink, '#!/bin/sh\necho "reexec=$TROPOS_REEXEC" > "$HOME/reexec.txt"\nexit 7\n', { mode: 0o755 });
    const r = await session(versionPath(f.layout, "1.0.0"));
    expect(r.code).toBe(7);
    expect((await readFile(join(f.home, "reexec.txt"), "utf8")).trim()).toBe("reexec=1");
  });

  test("a re-exec target that cannot run falls through to a normal start", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", link: "1.1.0" });
    await rm(versionPath(f.layout, "1.0.0"));
    await rm(f.layout.binLink);
    const r = await session(versionPath(f.layout, "1.0.0"));
    expect(r.err).toContain("interactive mode needs a terminal");
  });

  test("the update announcement goes to stderr", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    await writeState(f.layout, { ...emptyState(), current: "1.0.0", autoUpdate: { ...emptyState().autoUpdate, lastUpdated: "1.0.0", announced: false } });
    const r = await session(versionPath(f.layout, "1.0.0"));
    expect(r.err).toContain("Updated to 1.0.0\n");
    expect(r.out).not.toContain("Updated to");
  });
});
