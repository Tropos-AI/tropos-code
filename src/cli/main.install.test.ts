// src/cli/main.install.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEngineFixture, type EngineFixture } from "../../test/install/helpers/engine";
import { versionPath } from "../install/layout";
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
    expect(r.out).toContain("To stay on 'stable', set \"autoUpdatesChannel\": \"stable\"");
    expect(await readFile(settingsPath, "utf8")).toBe(settingsText);
  });

  test("install --help", async () => {
    f = await makeEngineFixture();
    const r = await run(["install", "--help"], "/usr/local/bin/bun");
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("Usage: tropos install");
  });
});
