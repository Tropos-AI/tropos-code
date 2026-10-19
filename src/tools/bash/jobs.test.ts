// src/tools/bash/jobs.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { localBackend } from "../../exec/local";
import { JobTable } from "./jobs";

const tables: JobTable[] = [];
afterEach(() => {
  for (const t of tables.splice(0)) t.killAll();
});

function table(limit?: number): JobTable {
  const t = new JobTable(limit);
  tables.push(t);
  return t;
}

const start = (t: JobTable, command: string) =>
  t.add(command, spawn("/bin/bash", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"] }));

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

describe("JobTable", () => {
  test("ids are sequential", () => {
    const t = table();
    expect([start(t, "true"), start(t, "true")]).toEqual(["bash-1", "bash-2"]);
  });

  test("collects stdout, stderr and the exit code", async () => {
    const t = table();
    const id = start(t, "echo hi; echo err >&2; exit 3");
    await t.settled(id);
    const r = t.read(id)!;
    expect(r.stdout).toBe("hi\n");
    expect(r.stderr).toBe("err\n");
    expect(r.status).toEqual({ state: "exited", code: 3 });
  });

  test("each read returns only output that is new since the last one", async () => {
    const t = table();
    const id = start(t, "echo first; sleep 0.3; echo second");
    await until(() => t.peek(id)!.includes("first"));
    expect(t.read(id)!.stdout).toBe("first\n");
    await t.settled(id);
    expect(t.read(id)!.stdout).toBe("second\n");
    expect(t.read(id)!.stdout).toBe("");
  });

  test("unread output is capped, keeping the start and the end", async () => {
    const t = table(1000);
    const id = start(t, "head -c 50000 /dev/zero | tr '\\0' 'a'; echo; echo END");
    await t.settled(id);
    const out = t.read(id)!.stdout;
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain("characters truncated");
    expect(out).toContain("END");
  });

  test("kill stops the whole process group", async () => {
    const t = table();
    const id = start(t, "sleep 30 & sleep 30; wait");
    const pid = t.pid(id)!;
    const status = await t.kill(id);
    expect(status).toEqual({ state: "killed", signal: "SIGTERM" });
    expect(() => process.kill(-pid, 0)).toThrow();
  });

  test("a job that ignores SIGTERM is killed anyway", async () => {
    const t = table();
    const id = start(t, "trap '' TERM; echo ready; while true; do sleep 0.1; done");
    await until(() => t.peek(id)!.includes("ready"));
    const status = await t.kill(id, 200);
    expect(status).toEqual({ state: "killed", signal: "SIGKILL" });
  });

  test("killAll signals every running job", async () => {
    const t = table();
    const ids = [start(t, "sleep 30"), start(t, "sleep 30")];
    const pids = ids.map((id) => t.pid(id)!);
    t.killAll();
    await Promise.all(ids.map((id) => t.settled(id)));
    for (const pid of pids) expect(() => process.kill(-pid, 0)).toThrow();
  });

  test("unknown ids", async () => {
    const t = table();
    expect(t.read("bash-9")).toBeUndefined();
    expect(await t.kill("bash-9")).toBeUndefined();
  });

  test("list describes every job", async () => {
    const t = table();
    const id = start(t, "exit 0");
    await t.settled(id);
    expect(t.list()).toEqual([{ id: "bash-1", command: "exit 0", status: { state: "exited", code: 0 } }]);
  });

  test("a job does not keep the process alive", async () => {
    // Run a child Bun process that starts a long job and then returns: it must exit promptly.
    const script = `
      import { spawn } from "node:child_process";
      import { JobTable } from ${JSON.stringify(import.meta.dir + "/jobs.ts")};
      const t = new JobTable();
      t.add("sleep 30", spawn("/bin/bash", ["-c", "sleep 30"], { detached: true, stdio: ["ignore", "pipe", "pipe"] }));
      console.log("started");
    `;
    const t0 = Date.now();
    const proc = Bun.spawnSync(["bun", "-e", script]);
    expect(proc.stdout.toString()).toContain("started");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("jobs are killed when the process exits", async () => {
    const script = `
      import { spawn } from "node:child_process";
      import { JobTable } from ${JSON.stringify(import.meta.dir + "/jobs.ts")};
      const t = new JobTable();
      const child = spawn("/bin/bash", ["-c", "sleep 30"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      t.add("sleep 30", child);
      console.log(child.pid);
    `;
    const proc = Bun.spawnSync(["bun", "-e", script]);
    const pid = Number(proc.stdout.toString().trim());
    expect(pid).toBeGreaterThan(0);
    await until(() => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  test("kill() and killAll() signal through the backend the job was added with", async () => {
    const calls: string[] = [];
    let running = true;
    const backend = {
      ...localBackend,
      kind: "docker" as const,
      signal: (_c: unknown, sig: string) => {
        calls.push(sig);
        if (sig === "SIGKILL") running = false;
      },
      alive: () => running,
    } as unknown as import("../../exec/backend").ExecBackend;
    const t = table();
    const child = spawn("/bin/bash", ["-c", "sleep 0.2"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const id = t.add("fake", child, backend);
    await t.kill(id, 50);
    expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
    t.killAll();
    expect(calls.at(-1)).toBe("SIGTERM");
    child.kill("SIGKILL");
  });

  test("kill() repeats SIGKILL while the group lives on, so a child forked just as the first one landed is not left behind", async () => {
    const calls: string[] = [];
    let kills = 0;
    const backend = {
      ...localBackend,
      signal: (_c: unknown, sig: string) => {
        calls.push(sig);
        if (sig === "SIGKILL") kills++;
      },
      alive: () => kills < 3,
    } as unknown as import("../../exec/backend").ExecBackend;
    const t = table();
    const child = spawn("/bin/bash", ["-c", "sleep 0.2"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const id = t.add("fake", child, backend);
    await t.kill(id, 50);
    expect(calls).toEqual(["SIGTERM", "SIGKILL", "SIGKILL", "SIGKILL"]);
    child.kill("SIGKILL");
  });
});
