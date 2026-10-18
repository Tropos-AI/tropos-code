// src/gateway/daemon.test.ts — the pieces of the daemon that the end-to-end tests don't reach.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FakeModel, reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { main } from "../cli/main";
import { CronStore } from "./cron/store";
import { loadGatewayConfig } from "./config";
import type { HelloInfo } from "../web/protocol";
import { dockerCheck, persistentToken, readGatewayState, type GatewayRun } from "./daemon";
import { addProject, removeProject, setDefaultProject } from "./projects";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-daemon");
});
afterEach(() => removeDir(dir));

describe("dockerCheck", () => {
  test("is quiet when Docker answers, and says what's wrong when it doesn't", async () => {
    expect(await dockerCheck("true")()).toBeUndefined();
    expect(await dockerCheck("false")()).toBe("Docker is installed but not running");
    expect(await dockerCheck(join(dir, "no-such-docker"))()).toBe("Docker isn't installed");
  });

  test("asks once per few seconds: every new chat session asks", async () => {
    let t = 0;
    const bin = join(dir, "docker");
    await Bun.write(bin, `#!/bin/sh\necho x >> ${join(dir, "calls")}\n`);
    await chmod(bin, 0o755);
    const check = dockerCheck(bin, () => t);
    await check();
    await check();
    t += 20_000;
    await check();
    expect((await readFile(join(dir, "calls"), "utf8")).trim().split("\n")).toHaveLength(2);
  });
});

describe("persistentToken", () => {
  test("is created once, kept private, and the same after a restart", async () => {
    const first = await persistentToken(join(dir, "gateway"));
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(await persistentToken(join(dir, "gateway"))).toBe(first);
    if (process.platform !== "win32") expect((await stat(join(dir, "gateway", "token"))).mode & 0o777).toBe(0o600);
  });
  test("a damaged token file is replaced rather than trusted", async () => {
    await mkdir(join(dir, "gateway"));
    await Bun.write(join(dir, "gateway", "token"), "short");
    expect((await persistentToken(join(dir, "gateway"))).length).toBeGreaterThanOrEqual(32);
  });
});

describe("tcode gateway", () => {
  const start = (extra: string[] = [], over: { cwd?: string; seams?: NonNullable<GatewayRun["seams"]> } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    let webUrl: string | undefined;
    const done = main(["gateway", ...extra], {
      model: new FakeModel([]),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      env: { TROPOS_HOME: join(dir, "home"), SHELL: "/bin/bash" },
      cwd: over.cwd ?? join(dir, "project"),
      gatewayUntil: async (info) => {
        webUrl = info.webUrl;
        await stopped;
      },
      gatewaySeams: { sweep: false, assets: new Map(), webPort: 0, ...over.seams },
    });
    return { done, stop, out, err, url: () => webUrl };
  };

  test("serves the local web UI on loopback with a link that survives restarts", async () => {
    await mkdir(join(dir, "project"));
    const first = start();
    await Bun.sleep(400);
    const url = first.url()!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await readGatewayState(join(dir, "home")))?.webPort).toBe(Number(new URL(url).port));
    first.stop();
    expect(await first.done).toBe(0);

    const second = start();
    await Bun.sleep(400);
    expect(new URL(second.url()!).searchParams.get("token")).toBe(new URL(url).searchParams.get("token"));
    second.stop();
    await second.done;
  });

  test("a taken port is reported with its holder and chats keep running", async () => {
    await mkdir(join(dir, "project"));
    const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    try {
      const runner = { exec: async (cmd: string) => (cmd === "lsof" ? { code: 0, stdout: "p999\ncnode\n", stderr: "" } : { code: null, stdout: "", stderr: "", error: "none" }) };
      const g = start([], { seams: { webPort: blocker.port!, runner } });
      await Bun.sleep(400);
      expect(g.err.join("")).toContain("is in use by node (pid 999)");
      const state = await readGatewayState(join(dir, "home"));
      expect(state?.webProblem).toContain("is in use by node (pid 999)");
      expect(state?.webPort).toBeUndefined();
      expect(g.url()).toBeUndefined();
      g.stop();
      expect(await g.done).toBe(0);
    } finally {
      blocker.stop(true);
    }
  });

  test("the dashboard's session has the owner's Cron tool: it sees every chat's jobs", async () => {
    await mkdir(join(dir, "project"));
    const job = new CronStore(join(dir, "home")).add({ name: "elsewhere", schedule: { kind: "every", ms: 120_000 }, prompt: "p", project: "default", deliver: "telegram:555", createdBy: "agent" });
    const model = new FakeModel([() => reply([toolUseBlock("c1", "Cron", { action: "list" })], "tool_use"), () => reply([textBlock("done")])]);
    let webUrl: string | undefined;
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const done = main(["gateway"], {
      model,
      out: () => {},
      err: () => {},
      env: { TROPOS_HOME: join(dir, "home"), SHELL: "/bin/bash" },
      cwd: join(dir, "project"),
      gatewayUntil: async (info) => {
        webUrl = info.webUrl;
        await stopped;
      },
      gatewaySeams: { sweep: false, assets: new Map(), webPort: 0 },
    });
    while (!webUrl) await Bun.sleep(20);
    const base = `http://127.0.0.1:${new URL(webUrl).port}`;
    const token = new URL(webUrl).searchParams.get("token")!;
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { Cookie: `tcode_session=${token}`, Origin: base } } as unknown as string[]);
    const finished = new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { t: string; id?: number };
        if (m.t === "ask") ws.send(JSON.stringify({ t: "permission", id: m.id, answer: { kind: "allow" } }));
        if (m.t === "rpc_result") resolve();
      };
    });
    await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
    ws.send(JSON.stringify({ t: "rpc", id: 1, method: "prompt", params: { text: "what is scheduled?" } }));
    await finished;
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain(job.id);
    ws.close();
    stop();
    expect(await done).toBe(0);
  });

  test("needs no workspace: it creates ~/.tropos/workspace with a .git and a README, and doesn't warn about it", async () => {
    const run = start(["--no-web"]);
    await Bun.sleep(400);
    const workspace = join(dir, "home", "workspace");
    expect((await stat(workspace)).isDirectory()).toBe(true);
    if (Bun.which("git")) expect((await stat(join(workspace, ".git"))).isDirectory()).toBe(true);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toContain("Tropos");
    expect(run.err.join("")).not.toContain("not a git repository");
    expect(run.out.join("")).toContain("projects: default (default: default)");
    run.stop();
    expect(await run.done).toBe(0);
  });

  test("--workspace is a one-off project named cwd; it warns when it has no .git, and isn't saved", async () => {
    await mkdir(join(dir, "project"));
    const plain = start(["--no-web", "--workspace", join(dir, "project")]);
    await Bun.sleep(300);
    expect(plain.err.join("")).toContain("is not a git repository");
    expect(plain.out.join("")).toContain("projects: default, cwd (default: cwd)");
    plain.stop();
    await plain.done;
    expect((await loadGatewayConfig(join(dir, "home"))).projects).toEqual([]);

    await mkdir(join(dir, "project", ".git"));
    const repo = start(["--no-web", "--workspace", join(dir, "project")]);
    await Bun.sleep(300);
    expect(repo.err.join("")).not.toContain("not a git repository");
    repo.stop();
    await repo.done;
  });

  test("refuses a workspace that holds Tropos's data directory", async () => {
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const run = start(["--no-web", "--workspace", dir]);
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toMatch(/pick a project directory/);
  });
});

describe("the dashboard's chat across a reload", () => {
  type RpcResult = { t: "rpc_result"; id: number; ok: boolean; result?: unknown; error?: string };
  type UntilInfo = Parameters<NonNullable<GatewayRun["until"]>>[0];
  const text = (t: string): Step => () => reply([textBlock(t)]);
  const memoryAdd: Step = () => reply([toolUseBlock("m1", "Memory", { target: "user", action: "add", content: "prefers bun" })], "tool_use");
  const saveSettings = async (settings: unknown) => {
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(join(dir, "home", "settings.json"), JSON.stringify(settings));
  };

  /** The gateway with its web UI, and one dashboard tab that answers every permission question with allow. */
  async function dashboard(steps: Step[]) {
    await mkdir(join(dir, "project"), { recursive: true });
    const model = new FakeModel(steps);
    let info: UntilInfo | undefined;
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const done = main(["gateway"], {
      model,
      out: () => {},
      err: () => {},
      env: { TROPOS_HOME: join(dir, "home"), SHELL: "/bin/bash" },
      cwd: join(dir, "project"),
      gatewayUntil: async (i) => {
        info = i;
        await stopped;
      },
      gatewaySeams: { sweep: false, assets: new Map(), webPort: 0 },
    });
    while (!info) await Bun.sleep(20);
    const url = new URL(info.webUrl!);
    const base = `http://127.0.0.1:${url.port}`;
    const sockets: WebSocket[] = [];
    /** One browser tab. */
    const connect = async () => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { Cookie: `tcode_session=${url.searchParams.get("token")}`, Origin: base } } as unknown as string[]);
      sockets.push(ws);
      const asked: string[] = [];
      const hellos: HelloInfo[] = [];
      const pending = new Map<number, (m: RpcResult) => void>();
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { t: string; id?: number; prompt?: { toolName: string }; server?: HelloInfo };
        if (m.t === "hello") hellos.push(m.server!);
        if (m.t === "ask") {
          asked.push(m.prompt!.toolName);
          ws.send(JSON.stringify({ t: "permission", id: m.id, answer: { kind: "allow" } }));
        }
        if (m.t === "rpc_result") pending.get(m.id!)?.(m as RpcResult);
      };
      await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
      while (hellos.length === 0) await Bun.sleep(5);
      let next = 1;
      const rpc = (method: string, params?: unknown) =>
        new Promise<RpcResult>((resolve) => {
          const id = next++;
          pending.set(id, resolve);
          ws.send(JSON.stringify({ t: "rpc", id, method, params }));
        });
      const prompt = async (t: string) => void (await rpc("prompt", { text: t }));
      return { rpc, prompt, hellos, asked };
    };
    const first = await connect();
    const finish = async () => {
      for (const ws of sockets) ws.close();
      stop();
      expect(await done).toBe(0);
    };
    return { model, info, connect, ...first, finish };
  }

  test("a deny rule saved while it is idle holds from its next turn, which goes on with the same conversation", async () => {
    const gw = await dashboard([text("hi there"), memoryAdd, text("ok")]);
    await gw.prompt("hello");
    await saveSettings({ permissions: { deny: ["Memory"] } });
    await gw.info.reload();
    await gw.prompt("remember that I prefer bun");
    expect(JSON.stringify(gw.model.requests[2]!.messages.at(-1))).toContain("Blocked by the deny rule");
    expect(JSON.stringify(gw.model.requests[1]!.messages)).toContain("hi there");
    await gw.finish();
  });

  test("a tab moves to another project, its chat works there, and a deny rule saved in that project holds after a reload", async () => {
    await mkdir(join(dir, "app", ".git"), { recursive: true });
    await addProject(join(dir, "home"), { path: join(dir, "app"), name: "App" }, { userHome: join(dir, "nobody") });
    const gw = await dashboard([text("hi from app"), memoryAdd, text("ok")]);
    expect(gw.hellos[0]?.project).toEqual({ id: "default", name: "Default workspace" });
    const moved = await gw.rpc("project.select", "app");
    const app = await realpath(join(dir, "app"));
    expect(moved).toMatchObject({ ok: true, result: { cwd: app, project: { id: "app", name: "App" } } });
    expect(gw.hellos.at(-1)).toMatchObject({ cwd: app, project: { id: "app", name: "App" } });
    expect(await gw.rpc("project.select", "nope")).toEqual({ t: "rpc_result", id: 2, ok: false, error: 'There is no project "nope".' });
    await gw.prompt("hello");
    await mkdir(join(dir, "app", ".tropos"), { recursive: true });
    await writeFile(join(dir, "app", ".tropos", "settings.json"), JSON.stringify({ permissions: { deny: ["Memory"] } }));
    await gw.info.reload();
    // The rebuilt host still names its project, and goes on with the same conversation.
    expect(gw.hellos.at(-1)).toMatchObject({ cwd: app, project: { id: "app" } });
    await gw.prompt("remember that I prefer bun");
    expect(JSON.stringify(gw.model.requests[2]!.messages.at(-1))).toContain("Blocked by the deny rule");
    expect(JSON.stringify(gw.model.requests[1]!.messages)).toContain("hi from app");
    await gw.finish();
  });

  test("a removed project's tab moves to the default at the reload; re-added at a new path, selecting it opens the new path", async () => {
    const home = join(dir, "home");
    await mkdir(join(dir, "app", ".git"), { recursive: true });
    await mkdir(join(dir, "moved", ".git"), { recursive: true });
    await addProject(home, { path: join(dir, "app"), name: "App" }, { userHome: join(dir, "nobody") });
    const gw = await dashboard([]);
    expect(await gw.rpc("project.select", "app")).toMatchObject({ ok: true, result: { cwd: await realpath(join(dir, "app")) } });
    await removeProject(home, "app");
    await gw.info.reload();
    // The reload has sent the moved tab its hello; the socket delivers it a moment later.
    while (gw.hellos.at(-1)?.project?.id !== "default") await Bun.sleep(5);
    expect(gw.hellos.at(-1)?.project).toEqual({ id: "default", name: "Default workspace" });
    // The same id again, elsewhere: `tcode projects add` doesn't reload the gateway, so the select itself notices.
    expect((await addProject(home, { path: join(dir, "moved"), name: "App" }, { userHome: join(dir, "nobody") })).id).toBe("app");
    expect(await gw.rpc("project.select", "app")).toMatchObject({ ok: true, result: { cwd: await realpath(join(dir, "moved")), project: { id: "app" } } });
    await gw.finish();
  });

  test("when the default project is removed, its tabs and new tabs land on the new default", async () => {
    const home = join(dir, "home");
    await mkdir(join(dir, "app", ".git"), { recursive: true });
    await addProject(home, { path: join(dir, "app"), name: "App" }, { userHome: join(dir, "nobody") });
    await setDefaultProject(home, "app");
    const gw = await dashboard([]);
    expect(gw.hellos[0]?.project).toEqual({ id: "app", name: "App" });
    await removeProject(home, "app");
    await gw.info.reload();
    // The reload has sent the moved tab its hello; the socket delivers it a moment later.
    while (gw.hellos.at(-1)?.project?.id !== "default") await Bun.sleep(5);
    expect(gw.hellos.at(-1)?.project).toEqual({ id: "default", name: "Default workspace" });
    expect((await gw.connect()).hellos[0]?.project).toEqual({ id: "default", name: "Default workspace" });
    await gw.finish();
  });

  test("a project's chat that was opening during a reload is rebuilt on the reloaded settings", async () => {
    // A SessionStart hook holds the app's opening host (once armed) until the reload has run; other hosts pass.
    const [armed, started, go] = ["armed", "started", "go"].map((f) => join(dir, f));
    const wait = `if [ -f ${armed} ]; then touch ${started}; while [ ! -f ${go} ]; do sleep 0.05; done; fi`;
    const hook = { SessionStart: [{ hooks: [{ type: "command", command: `case "$PWD" in */app) ${wait};; esac` }] }] };
    await saveSettings({ hooks: hook });
    await mkdir(join(dir, "app", ".git"), { recursive: true });
    await addProject(join(dir, "home"), { path: join(dir, "app"), name: "App" }, { userHome: join(dir, "nobody") });
    const gw = await dashboard([memoryAdd, text("ok")]);
    await writeFile(armed, "");
    const selecting = gw.rpc("project.select", "app");
    while (!existsSync(started)) await Bun.sleep(10);
    // Its context is loaded (without the rule) and its session is starting when the rule is saved.
    await saveSettings({ hooks: hook, permissions: { deny: ["Memory"] } });
    await gw.info.reload();
    await writeFile(go, "");
    expect(await selecting).toMatchObject({ ok: true });
    await gw.prompt("remember that I prefer bun");
    expect(JSON.stringify(gw.model.requests[1]!.messages.at(-1))).toContain("Blocked by the deny rule");
    await gw.finish();
  });

  test("a busy chat in another project is rebuilt after its turn; its next turn asks before saving", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await mkdir(join(dir, "app", ".git"), { recursive: true });
    await addProject(join(dir, "home"), { path: join(dir, "app"), name: "App" }, { userHome: join(dir, "nobody") });
    const gw = await dashboard([async () => (await gate, reply([textBlock("first answer")])), memoryAdd, text("ok")]);
    await gw.rpc("project.select", "app");
    const turn = gw.prompt("hello");
    while (gw.model.requests.length < 1) await Bun.sleep(10);
    await saveSettings({ learning: { askBeforeSaving: true } });
    // Returns without waiting for the turn.
    await gw.info.reload();
    release();
    await turn;
    await gw.prompt("remember that I prefer bun");
    expect(gw.asked).toEqual(["Memory"]);
    expect(JSON.stringify(gw.model.requests[1]!.messages)).toContain("first answer");
    expect(gw.hellos.at(-1)).toMatchObject({ project: { id: "app" } });
    await gw.finish();
  });

  test("askBeforeSaving saved during a turn doesn't hold up the save; the next turn asks before saving", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gw = await dashboard([async () => (await gate, reply([textBlock("first answer")])), memoryAdd, text("ok")]);
    const turn = gw.prompt("hello");
    while (gw.model.requests.length < 1) await Bun.sleep(10);
    await saveSettings({ learning: { askBeforeSaving: true } });
    await gw.info.reload();
    release();
    await turn;
    await gw.prompt("remember that I prefer bun");
    expect(gw.asked).toEqual(["Memory"]);
    expect(JSON.stringify(gw.model.requests[1]!.messages)).toContain("first answer");
    await gw.finish();
  });
});

describe("the web link in the gateway's output", () => {
  const run = async () => {
    const out: string[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    await mkdir(join(dir, "project"), { recursive: true });
    const done = main(["gateway"], {
      model: new FakeModel([]),
      out: (s) => out.push(s),
      err: () => {},
      env: { TROPOS_HOME: join(dir, "home"), SHELL: "/bin/bash" },
      cwd: join(dir, "project"),
      gatewayUntil: async () => void (await stopped),
      gatewaySeams: { sweep: false, assets: new Map(), webPort: 0 },
    });
    await Bun.sleep(400);
    stop();
    await done;
    return out.join("");
  };
  test("without a terminal (under a service) the output has the address but not the key", async () => {
    const text = await run();
    expect(text).toMatch(/web: http:\/\/127\.0\.0\.1:\d+\/ \(open it with: tcode dashboard\)/);
    expect(text).not.toContain("token=");
  });
});
