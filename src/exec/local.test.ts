// src/exec/local.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { LocalBackend, localBackend } from "./local";

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
};
const collect = (child: import("node:child_process").ChildProcess) =>
  new Promise<{ out: string; err: string; code: number | null }>((resolve) => {
    let out = "";
    let err = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.once("close", (code) => resolve({ out, err, code }));
  });

describe("LocalBackend", () => {
  test("is exported as a shared instance", () => {
    expect(localBackend).toBeInstanceOf(LocalBackend);
    expect(localBackend.kind).toBe("local");
  });

  test("runs the script with the given cwd and environment only", async () => {
    const r = await collect(localBackend.spawn({ shell: "/bin/sh", script: 'pwd; echo "$ONLY_THIS"; echo "${HOME-unset}"', cwd: tmpdir(), env: { ONLY_THIS: "yes" } }));
    const [pwd, only, home] = r.out.split("\n");
    expect(realpathSync(pwd!)).toBe(realpathSync(tmpdir()));
    expect(only).toBe("yes");
    expect(home).toBe("unset");
    expect(r.code).toBe(0);
  });

  test("stdin is ignored and exit codes pass through", async () => {
    const r = await collect(localBackend.spawn({ shell: "/bin/sh", script: "cat; exit 7", cwd: tmpdir(), env: {} }));
    expect(r.out).toBe("");
    expect(r.code).toBe(7);
  });

  test("the cwd marker is the same path inside and on the host", () => {
    const m = localBackend.cwdMarker("abc");
    expect(m.inside).toBe(m.host);
    expect(m.host.startsWith(tmpdir())).toBe(true);
    expect(m.host).toContain("abc");
    expect(existsSync(m.host)).toBe(false);
  });

  test("signal() reaches the whole process group; alive() tracks it", async () => {
    const child = localBackend.spawn({ shell: "/bin/sh", script: "sleep 30 & sleep 30; wait", cwd: tmpdir(), env: process.env });
    child.stdout!.resume();
    child.stderr!.resume();
    expect(localBackend.alive(child)).toBe(true);
    const closed = new Promise((r) => child.once("close", r));
    localBackend.signal(child, "SIGTERM");
    await closed;
    await until(() => !localBackend.alive(child));
  });

  test("signal() and alive() on a finished or unstarted child never throw", async () => {
    const child = localBackend.spawn({ shell: "/bin/sh", script: "true", cwd: tmpdir(), env: {} });
    await collect(child);
    expect(() => localBackend.signal(child, "SIGKILL")).not.toThrow();
    const bad = localBackend.spawn({ shell: "/nonexistent/shell", script: "true", cwd: tmpdir(), env: {} });
    bad.on("error", () => {});
    expect(() => localBackend.signal(bad, "SIGTERM")).not.toThrow();
    expect(localBackend.alive(bad)).toBe(false);
  });

  test("close() is a no-op that can be repeated", async () => {
    await localBackend.close();
    await localBackend.close();
  });
});
