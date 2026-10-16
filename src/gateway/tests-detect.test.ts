// src/gateway/tests-detect.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { detectTestCommands, isTestManifest, matchesTestCommand } from "./tests-detect";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("tests-detect");
});
afterEach(async () => {
  await removeDir(dir);
});

async function write(name: string, content: unknown = ""): Promise<void> {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  await mkdir(dirname(join(dir, name)), { recursive: true });
  await writeFile(join(dir, name), text);
}

describe("detectTestCommands", () => {
  test("a bun project: the package script through bun, and bun's own runner", async () => {
    await write("package.json", { scripts: { test: "bun test" } });
    await write("bun.lock", "");
    expect(await detectTestCommands(dir)).toEqual(["bun run test", "bun test"]);
  });

  test("the package script runner follows the lockfile", async () => {
    await write("package.json", { scripts: { test: "vitest" } });
    expect(await detectTestCommands(dir)).toEqual(["npm test"]);
    await write("pnpm-lock.yaml");
    expect(await detectTestCommands(dir)).toEqual(["pnpm test"]);
    await write("yarn.lock");
    expect(await detectTestCommands(dir)).toEqual(["pnpm test"]);
  });

  test("yarn.lock alone picks yarn; bunfig.toml alone adds bun test", async () => {
    await write("package.json", { scripts: { test: "x" } });
    await write("yarn.lock");
    await write("bunfig.toml");
    expect(await detectTestCommands(dir)).toEqual(["yarn test", "bun test"]);
  });

  test("npm's placeholder test script isn't a test command", async () => {
    await write("package.json", { scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(await detectTestCommands(dir)).toEqual([]);
  });

  test("cargo, go, pytest (pyproject [tool.pytest]), make test, just test, deno", async () => {
    await write("Cargo.toml");
    await write("go.mod");
    await write("pyproject.toml", "[tool.pytest.ini_options]\n");
    await write("Makefile", "build:\n\tcc\ntest:\n\t./t\n");
    await write("justfile", "test arg:\n  echo\n");
    await write("deno.json", "{}");
    expect(await detectTestCommands(dir)).toEqual([
      "cargo test",
      "go test ./...",
      "pytest",
      "make test",
      "just test",
      "deno test",
    ]);
  });

  test("other pytest markers; a Makefile without a test target adds nothing", async () => {
    await write("tox.ini", "[pytest]\n");
    await write("makefile", "testing:\n\techo\n");
    await write(".justfile", "build:\n  echo\n");
    expect(await detectTestCommands(dir)).toEqual(["pytest"]);
    await write("pytest.ini");
    expect(await detectTestCommands(dir)).toEqual(["pytest"]);
  });

  test("setup.cfg and plain pyproject only count with a pytest section", async () => {
    await write("setup.cfg", "[metadata]\n");
    await write("pyproject.toml", "[project]\n");
    expect(await detectTestCommands(dir)).toEqual([]);
    await write("setup.cfg", "[tool:pytest]\n");
    expect(await detectTestCommands(dir)).toEqual(["pytest"]);
  });

  test("an empty or unreadable project has none", async () => {
    expect(await detectTestCommands(dir)).toEqual([]);
    expect(await detectTestCommands(join(dir, "missing"))).toEqual([]);
    await write("package.json", "{not json");
    await mkdir(join(dir, "Makefile"));
    expect(await detectTestCommands(dir)).toEqual([]);
  });
});

describe("isTestManifest", () => {
  test("package.json at any depth, configs, case-insensitive on darwin; source files are not", () => {
    expect(isTestManifest("/w/app/packages/x/package.json")).toBe(true);
    expect(isTestManifest("/w/app/vitest.config.ts")).toBe(true);
    expect(isTestManifest("/w/app/.cargo/config.toml")).toBe(true);
    expect(isTestManifest("/w/app/.cargo/config")).toBe(true);
    expect(isTestManifest("/w/app/PACKAGE.JSON", "darwin")).toBe(true);
    expect(isTestManifest("/w/app/PACKAGE.JSON", "linux")).toBe(false);
    expect(isTestManifest("/w/app/.mocharc.yml")).toBe(true);
    expect(isTestManifest("/w/app/jest.config.cjs")).toBe(true);
    expect(isTestManifest("/w/app/conftest.py")).toBe(true);
    expect(isTestManifest("/w/app/src/a.test.ts")).toBe(false);
    expect(isTestManifest("/w/app/config.toml")).toBe(false);
    expect(isTestManifest("/w/app/other/config")).toBe(false);
  });
});

describe("matchesTestCommand", () => {
  test("the pinned command, with extra plain arguments, nothing else", () => {
    expect(matchesTestCommand("bun test", ["bun test"])).toBe(true);
    expect(matchesTestCommand("bun test src/a.test.ts", ["bun test"])).toBe(true);
    expect(matchesTestCommand("bun  test   src/a.test.ts", ["bun test"])).toBe(true);
    expect(matchesTestCommand("bun testx", ["bun test"])).toBe(false);
    expect(matchesTestCommand("FOO=1 bun test", ["bun test"])).toBe(false);
    expect(matchesTestCommand("bun test $X", ["bun test"])).toBe(false);
    expect(matchesTestCommand("bun test > out", ["bun test"])).toBe(false);
    expect(matchesTestCommand("bun test < in", ["bun test"])).toBe(false);
    expect(matchesTestCommand("bun test `id`", ["bun test"])).toBe(false);
    expect(matchesTestCommand("bun test", [])).toBe(false);
  });

  test("a chained or option-bearing command is not the pin", () => {
    const pin = ["bun test"];
    expect(matchesTestCommand("bun test; rm -rf x", pin)).toBe(false);
    expect(matchesTestCommand("bun test && rm x", pin)).toBe(false);
    expect(matchesTestCommand("bun test | tee x", pin)).toBe(false);
    expect(matchesTestCommand("bun test &", pin)).toBe(false);
    expect(matchesTestCommand("bun test\nrm x", pin)).toBe(false);
    expect(matchesTestCommand("bun test --preload ./evil.ts", pin)).toBe(false);
    expect(matchesTestCommand("bun test -r x", pin)).toBe(false);
    expect(matchesTestCommand("bun test $(id)", pin)).toBe(false);
    expect(matchesTestCommand("bun test 'a b'", pin)).toBe(false);
    expect(matchesTestCommand("bun test ~/x", pin)).toBe(false);
    expect(matchesTestCommand("bun test *.ts", pin)).toBe(false);
    expect(matchesTestCommand("env bun test", pin)).toBe(false);
  });
});
