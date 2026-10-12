// src/tools/bash/bash.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { bashTool } from "./bash";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "sub"));
});

// The background-job test deliberately leaves `sleep 20` running (that is the point of the test).
// Kill only processes whose working directory is this test's unique temp dir.
function killLeftoverJobs() {
  const root = dir; // makeTmpDir returns the canonical path
  const pids = Bun.spawnSync(["pgrep", "-x", "sleep"]).stdout.toString().split("\n").filter(Boolean);
  for (const pid of pids) {
    const cwd = Bun.spawnSync(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"]).stdout.toString();
    if (cwd.split("\n").includes(`n${root}`)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

afterAll(async () => {
  killLeftoverJobs();
  await removeDir(dir);
});

const ctx = () => makeToolContext({ root: dir });

describe("Bash", () => {
  test("returns stdout", async () => {
    const out = await bashTool.run({ command: "echo hello" }, ctx());
    expect(out.content).toBe("hello");
    expect(out.isError).toBeUndefined();
  });

  test("labels stderr and reports non-zero exit codes", async () => {
    const out = await bashTool.run({ command: "echo oops >&2; exit 3" }, ctx());
    expect(out.content).toBe("[stderr]\noops\n[exit code 3]");
    expect(out.isError).toBe(true);
  });

  test("no output", async () => {
    expect((await bashTool.run({ command: "true" }, ctx())).content).toBe("(no output)");
  });

  test("cd persists between calls", async () => {
    const c = ctx();
    await bashTool.run({ command: "cd sub" }, c);
    expect(c.cwd()).toBe(join(dir, "sub"));
    expect((await bashTool.run({ command: "pwd -P" }, c)).content).toBe(join(dir, "sub"));
  });

  test("cd outside the project is not kept", async () => {
    const c = ctx();
    const out = await bashTool.run({ command: "cd / && pwd" }, c);
    expect(c.cwd()).toBe(dir);
    expect(out.content).toContain("outside the project");
  });

  test("times out and kills the process", async () => {
    const started = Date.now();
    const out = await bashTool.run({ command: "sleep 20", timeout_ms: 1000 }, ctx());
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.content).toContain("timed out");
    expect(out.isError).toBe(true);
  });

  test("timeout kills the whole process group", async () => {
    const started = Date.now();
    await bashTool.run({ command: "sleep 20 & sleep 20", timeout_ms: 1000 }, ctx());
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("a background job doesn't keep the call open", async () => {
    const started = Date.now();
    const out = await bashTool.run({ command: "sleep 20 & echo started" }, ctx());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.content).toContain("started");
  });

  test("abort interrupts the command", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const out = await bashTool.run({ command: "sleep 20" }, makeToolContext({ root: dir, signal: controller.signal }));
    expect(out.content).toContain("[interrupted by user]");
    expect(out.isError).toBe(true);
  });

  test("long output is truncated in the middle", async () => {
    const out = await bashTool.run({ command: "head -c 100000 /dev/zero | tr '\\0' 'a'" }, ctx());
    expect(String(out.content).length).toBeLessThan(31_000);
    expect(out.content).toContain("characters truncated");
  });

  test("subject is the command", () => {
    expect(bashTool.subject({ command: "ls" }, dir)).toEqual({ command: "ls", paths: [] });
  });
});
