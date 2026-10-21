// src/harness/workspace.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { confinedBackend, confinementAvailable } from "../exec/confined";
import { defaultChecks, defaultSetup, runBackendCommand, runHostCommand } from "./workspace";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("lab-ws-");
});
afterEach(() => removeDir(dir));

test("a probe's copy inside the Tropos home is readable in the sandbox; the owner's keys and secrets are not", async () => {
  if (!(await confinementAvailable())) return;
  const userHome = join(dir, "user");
  const owner = join(userHome, ".tropos");
  const ws = join(owner, "harness", "lab", "r1", "ref", "ws");
  const harness = join(owner, "harness", "lab", "r1", "ref", "harness");
  const probeHome = join(owner, "harness", "lab", "r1", "ref", "home");
  await mkdir(ws, { recursive: true });
  await mkdir(join(harness, "scripts"), { recursive: true });
  await mkdir(probeHome, { recursive: true });
  await mkdir(join(userHome, ".ssh"), { recursive: true });
  await writeFile(join(ws, "a.txt"), "project");
  await writeFile(join(harness, "scripts", "s.sh"), "script");
  await writeFile(join(owner, "credentials.json"), "secret");
  await writeFile(join(userHome, ".ssh", "id"), "key");
  const backend = confinedBackend({ project: ws, home: probeHome, userHome, env: process.env, readable: [harness] });
  try {
    const run = (cmd: string) => runBackendCommand(backend, cmd, ws, {}, 30_000);
    expect((await run("cat a.txt")).tail).toBe("project");
    expect((await run(`cat ${join(harness, "scripts", "s.sh")}`)).ok).toBe(true);
    expect((await run(`cat ${join(owner, "credentials.json")}`)).ok).toBe(false);
    expect((await run(`cat ${join(userHome, ".ssh", "id")}`)).ok).toBe(false);
    // (Writes outside the project are refused by the sandbox's base rule; this fixture lives in the writable TMPDIR.)
    expect((await run("echo y > b.txt")).ok).toBe(true);
  } finally {
    await backend.close();
  }
});

test("host commands report exit, output and timeouts", async () => {
  expect(await runHostCommand("echo hi; exit 2", dir, 10_000)).toMatchObject({ ok: false, exit: 2, timedOut: false, tail: "hi\n" });
  expect(await runHostCommand("sleep 5", dir, 100)).toMatchObject({ ok: false, timedOut: true });
});

test("setup and checks follow the project's stack", async () => {
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }));
  expect(defaultSetup(dir, "ts-bun")).toBe("bun install --frozen-lockfile");
  expect(defaultSetup(dir, "ts-node")).toBeUndefined();
  expect(defaultChecks(dir, "ts-bun")).toEqual(["bun test", "bun run typecheck"]);
  expect(defaultChecks(dir, "ts-node")).toEqual(["npm test --silent", "npm run typecheck --silent"]);
  expect(defaultChecks(dir, "rust")).toEqual(["cargo test --quiet"]);
  expect(defaultChecks(dir, "general")).toEqual([]);
});
