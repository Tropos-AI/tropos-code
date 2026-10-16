// src/doctor/runner.test.ts — the real Runner, exercised with harmless commands, temp dirs and a loopback server.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { defaultRunner } from "./runner";

const runner = defaultRunner();

describe("exec", () => {
  test("captures stdout and stderr and a zero exit", async () => {
    const r = await runner.exec("sh", ["-c", "echo out; echo err >&2"]);
    expect(r).toEqual({ code: 0, stdout: "out\n", stderr: "err\n" });
  });

  test("passes args through without a shell", async () => {
    const r = await runner.exec("echo", ["a b", "$HOME"]);
    expect(r.stdout).toBe("a b $HOME\n");
  });

  test("a non-zero exit is a code, not an error", async () => {
    const r = await runner.exec("sh", ["-c", "echo partial; exit 3"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("partial\n");
    expect(r.error).toBeUndefined();
  });

  test("a missing binary reports 'not found' with a null code", async () => {
    const r = await runner.exec("tcode-no-such-binary-xyz", []);
    expect(r.code).toBeNull();
    expect(r.error).toBe("tcode-no-such-binary-xyz: not found");
  });

  test("a command that outlives the timeout is killed", async () => {
    const started = Date.now();
    const r = await runner.exec("sleep", ["30"], 100);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.code).toBeNull();
    expect(r.error).toBe("sleep timed out after 0.1s");
  });

  test("output produced before the timeout is kept", async () => {
    const r = await runner.exec("sh", ["-c", "echo early; sleep 30"], 300);
    expect(r.error).toContain("timed out");
    expect(r.stdout).toBe("early\n");
  });

  test("a spawn that throws synchronously is reported, not thrown", async () => {
    const r = await runner.exec("sh", ["bad\0arg"]);
    expect(r.code).toBeNull();
    expect(typeof r.error).toBe("string");
  });

  test("a non-executable file is reported with the system message", async () => {
    const dir = await makeTmpDir("runner-");
    try {
      const file = join(dir, "plain");
      await writeFile(file, "not a program", { mode: 0o644 });
      const r = await runner.exec(file, []);
      expect(r.code).toBeNull();
      expect(r.error).toMatch(/EACCES|permission/i);
    } finally {
      await removeDir(dir);
    }
  });
});

describe("pidAlive", () => {
  test("is true for this process", () => {
    expect(runner.pidAlive(process.pid)).toBe(true);
  });

  test("is false for a child that has exited", async () => {
    const child = spawn("true");
    const pid = child.pid!;
    await new Promise((r) => child.once("close", r));
    expect(runner.pidAlive(pid)).toBe(false);
  });
});

describe("fetch and listModels against a loopback server", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/models") return Response.json({ data: [{ id: "zeta" }, { id: "alpha" }, { id: "alpha" }] });
        if (url.pathname === "/hello") return new Response("hi", { status: 201 });
        return new Response("no", { status: 404 });
      },
    });
  });
  afterEach(() => server.stop(true));

  test("fetch forwards the request and init", async () => {
    const res = await runner.fetch(`http://127.0.0.1:${server.port}/hello`, { method: "POST" });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hi");
  });

  test("listModels asks the named provider and returns sorted, de-duplicated ids", async () => {
    const home = await makeTmpDir("runner-home-");
    try {
      const ids = await runner.listModels({
        home,
        env: {},
        settings: { localtest: { baseURL: `http://127.0.0.1:${server.port}` } },
        id: "localtest",
        signal: new AbortController().signal,
      });
      expect(ids).toEqual(["alpha", "zeta"]);
    } finally {
      await removeDir(home);
    }
  });

  test("listModels rejects an unknown provider", async () => {
    const home = await makeTmpDir("runner-home-");
    try {
      await expect(runner.listModels({ home, env: {}, settings: {}, id: "nope", signal: new AbortController().signal })).rejects.toThrow("Unknown provider nope");
    } finally {
      await removeDir(home);
    }
  });
});

describe("lazy wrappers", () => {
  let home: string;
  beforeEach(async () => {
    home = await makeTmpDir("runner-proj-");
  });
  afterEach(() => removeDir(home));

  test("listProjects returns the built-in project for an empty home", async () => {
    const projects = await runner.listProjects(home);
    expect(projects.length).toBeGreaterThanOrEqual(1);
    expect(projects[0]!.path).toBeTruthy();
  });

  test("listProjects includes projects from the gateway config", async () => {
    const proj = join(home, "my-project");
    await mkdir(proj, { recursive: true });
    await writeFile(join(home, "gateway.json"), JSON.stringify({ projects: [{ id: "mine", name: "Mine", path: proj }] }));
    const projects = await runner.listProjects(home);
    expect(projects.map((p) => p.id)).toContain("mine");
    expect(projects.find((p) => p.id === "mine")!.path).toBe(proj);
  });

  test("serviceStatus returns a status object (read-only)", async () => {
    const s = await runner.serviceStatus();
    expect(typeof s.installed).toBe("boolean");
    expect(typeof s.running).toBe("boolean");
  });

  test("sweepContainers removes nothing when docker is unavailable", async () => {
    const empty = await makeTmpDir("runner-path-");
    const saved = process.env.PATH;
    process.env.PATH = empty;
    try {
      expect(await runner.sweepContainers()).toBe(0);
    } finally {
      process.env.PATH = saved;
      await removeDir(empty);
    }
  });
});
