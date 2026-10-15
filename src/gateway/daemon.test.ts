// src/gateway/daemon.test.ts — the pieces of the daemon that the end-to-end tests don't reach.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { main } from "../cli/main";
import { dockerCheck, persistentToken, readGatewayState } from "./daemon";

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
  const start = (extra: string[] = [], over: { cwd?: string } = {}) => {
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
      gatewaySeams: { sweep: false, assets: new Map() },
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

  test("warns when the workspace has no .git, which a mount can't protect", async () => {
    await mkdir(join(dir, "project"));
    const plain = start(["--no-web"]);
    await Bun.sleep(300);
    expect(plain.err.join("")).toContain("is not a git repository");
    plain.stop();
    await plain.done;

    await mkdir(join(dir, "project", ".git"));
    const repo = start(["--no-web"]);
    await Bun.sleep(300);
    expect(repo.err.join("")).not.toContain("not a git repository");
    repo.stop();
    await repo.done;
  });

  test("refuses a workspace that holds Tropos's data directory", async () => {
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const run = start(["--no-web"], { cwd: dir });
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toMatch(/pick a project directory/);
  });
});
