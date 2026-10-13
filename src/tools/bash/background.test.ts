// src/tools/bash/background.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { bashOutputTool, killShellTool } from "./background";
import { bashTool } from "./bash";
import { JobTable } from "./jobs";

let dir: string;
const jobs = new JobTable();
beforeAll(async () => {
  dir = await makeTmpDir();
});
afterAll(async () => {
  jobs.killAll();
  await removeDir(dir);
});

const ctx = () => makeToolContext({ root: dir, jobs });

async function untilOutput(id: string, text: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!jobs.peek(id)?.includes(text)) {
    if (Date.now() > end) throw new Error(`no "${text}" from ${id}`);
    await Bun.sleep(20);
  }
}

describe("background jobs through the tools", () => {
  test("run_in_background returns at once with a job id, in the project directory", async () => {
    const t = Date.now();
    const out = await bashTool.run({ command: "pwd -P; echo booted; sleep 30", run_in_background: true }, ctx());
    expect(Date.now() - t).toBeLessThan(1000);
    expect(out.isError).toBeUndefined();
    const id = /bash-\d+/.exec(String(out.content))![0];
    expect(out.content).toContain("BashOutput");
    await untilOutput(id, "booted");
    const read = await bashOutputTool.run({ job_id: id }, ctx());
    expect(read.content).toContain(`${dir}\nbooted`);
    expect(read.content).toContain("running");
    expect(read.summary).toBe("running");
    const killed = await killShellTool.run({ job_id: id }, ctx());
    expect(killed.content).toContain("killed by SIGTERM");
    expect(killed.isError).toBeUndefined();
  });

  test("a background job does not change the working directory", async () => {
    const c = ctx();
    const out = await bashTool.run({ command: "cd /; sleep 0.1", run_in_background: true }, c);
    const id = /bash-\d+/.exec(String(out.content))![0];
    await jobs.settled(id);
    expect(c.cwd()).toBe(dir);
  });

  test("background jobs don't inherit credentials", async () => {
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp-secret";
    try {
      const out = await bashTool.run({ command: 'echo "[$GITHUB_TOKEN]"', run_in_background: true }, ctx());
      const id = /bash-\d+/.exec(String(out.content))![0];
      await jobs.settled(id);
      expect((await bashOutputTool.run({ job_id: id }, ctx())).content).toContain("[]");
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
    }
  });

  test("BashOutput reports the exit code, stderr, and nothing new on a second read", async () => {
    const out = await bashTool.run({ command: "echo done; echo warn >&2; exit 2", run_in_background: true }, ctx());
    const id = /bash-\d+/.exec(String(out.content))![0];
    await jobs.settled(id);
    const first = await bashOutputTool.run({ job_id: id }, ctx());
    expect(first.content).toContain("exited with code 2");
    expect(first.content).toContain("done");
    expect(first.content).toContain("[stderr]\nwarn");
    const second = await bashOutputTool.run({ job_id: id }, ctx());
    expect(second.content).toContain("(no new output)");
  });

  test("KillShell on a job that already finished says so", async () => {
    const out = await bashTool.run({ command: "true", run_in_background: true }, ctx());
    const id = /bash-\d+/.exec(String(out.content))![0];
    await jobs.settled(id);
    expect((await killShellTool.run({ job_id: id }, ctx())).content).toContain("had already exited with code 0");
  });

  test("unknown job ids are errors that list the jobs there are", async () => {
    const read = await bashOutputTool.run({ job_id: "bash-999" }, ctx());
    expect(read.isError).toBe(true);
    expect(read.content).toContain("No background job bash-999");
    expect(read.content).toContain("bash-1");
    const kill = await killShellTool.run({ job_id: "bash-999" }, ctx());
    expect(kill.isError).toBe(true);
  });

  test("both tools are bookkeeping over the agent's own jobs: meta, no paths", () => {
    expect(bashOutputTool.kind).toBe("meta");
    expect(killShellTool.kind).toBe("meta");
    expect(bashOutputTool.subject({ job_id: "bash-1" }, dir)).toEqual({ paths: [] });
    expect(killShellTool.subject({ job_id: "bash-1" }, dir)).toEqual({ paths: [] });
  });
});
