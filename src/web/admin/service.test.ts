import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adminWith, failure, fail, fakeService, makeKit, ok, type Kit } from "./host-testkit";
import { serviceHandlers } from "./service";
import type { RunResult } from "../../doctor/types";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit({ execPath: "/opt/bin/bun", scriptPath: "/src/main.ts" });
});
afterEach(() => kit.close());

const noGit = async () => {};
const docker = (answers: (args: string[]) => RunResult | { error: string }) => {
  const calls: { args: string[]; timeout?: number }[] = [];
  return {
    calls,
    runner: {
      exec: async (_cmd: string, args: string[], timeout?: number) => {
        calls.push({ args, timeout });
        const r = answers(args);
        return "error" in r ? { code: null, stdout: "", stderr: "", error: r.error } : r;
      },
    },
  };
};

test("install builds the spec like `tcode gateway install`; status and controls map the manager", async () => {
  const service = fakeService();
  const a = adminWith(kit, serviceHandlers(kit.ctx, { service, git: noGit }));
  const installed = (await a.handle("service.install", undefined)) as any;
  expect(installed).toEqual({ manager: "launchd", installed: true, running: true, unitPath: "/fake/unit.plist" });
  expect(service.specs[0]).toMatchObject({ programArguments: ["/opt/bin/bun", "/src/main.ts", "gateway"], workingDirectory: kit.home, logPath: join(kit.home, "gateway", "gateway.log") });
  expect(service.specs[0]!.env.TROPOS_HOME).toBe(kit.home);
  expect(service.specs[0]!.env.HOME).toBe(kit.userHome);
  expect(await a.handle("service.stop", undefined)).toMatchObject({ installed: true, running: false });
  expect(await a.handle("service.start", undefined)).toMatchObject({ running: true });
  expect(await a.handle("service.restart", undefined)).toMatchObject({ running: true });
  expect(await a.handle("service.status", undefined)).toMatchObject({ unitPath: "/fake/unit.plist", logPath: join(kit.home, "gateway", "gateway.log") });
  expect(await a.handle("service.uninstall", undefined)).toEqual({ removed: true });
  expect(await a.handle("service.uninstall", undefined)).toEqual({ removed: false });
});

test("controls refuse when not installed; manager errors are shown as is", async () => {
  const service = fakeService();
  const a = adminWith(kit, serviceHandlers(kit.ctx, { service, git: noGit }));
  expect(await failure(a, "service.start", undefined)).toContain("isn't installed");
  expect(service.calls).toEqual([]);
  const broken = { ...fakeService({ installed: true }), start: async () => { throw new Error("launchctl: Bootstrap failed: 5"); } };
  expect(await failure(adminWith(kit, serviceHandlers(kit.ctx, { service: broken })), "service.start", undefined)).toBe("launchctl: Bootstrap failed: 5");
});

test("sandbox.check: no docker, daemon down, image present, missing, and pull with a 5-minute cap", async () => {
  await writeFile(join(kit.home, "gateway.json"), JSON.stringify({ sandbox: { image: "alpine:test" } }));
  const run = (d: ReturnType<typeof docker>) => adminWith(kit, serviceHandlers(kit.ctx, { service: fakeService(), runner: d.runner }));

  const none = docker(() => ({ error: "docker: not found" }));
  expect(await run(none).handle("sandbox.check", undefined)).toMatchObject({ ok: false, docker: false, image: "alpine:test", imagePresent: false, problem: expect.stringContaining("isn't installed") });

  const down = docker(() => fail("Cannot connect"));
  expect(((await run(down).handle("sandbox.check", undefined)) as any).problem).toContain("daemon");

  const present = docker(() => ok("sha256:abc"));
  expect(await run(present).handle("sandbox.check", { pull: true })).toEqual({ ok: true, docker: true, image: "alpine:test", imagePresent: true });
  expect(present.calls.some((c) => c.args[0] === "pull")).toBe(false);

  const missing = docker((args) => (args[0] === "info" ? ok("27") : fail("no such image")));
  const noPull = (await run(missing).handle("sandbox.check", undefined)) as any;
  expect(noPull).toMatchObject({ ok: false, docker: true, imagePresent: false });
  expect(missing.calls.some((c) => c.args[0] === "pull")).toBe(false);

  let pulled = false;
  const pulling = docker((args) => {
    if (args[0] === "pull") return (pulled = true), ok();
    if (args[0] === "image") return pulled ? ok("sha256:abc") : fail("no such image");
    return ok("27");
  });
  expect(await run(pulling).handle("sandbox.check", { pull: true })).toMatchObject({ ok: true, imagePresent: true });
  expect(pulling.calls.find((c) => c.args[0] === "pull")).toEqual({ args: ["pull", "alpine:test"], timeout: 300_000 });

  const pullFails = docker((args) => (args[0] === "pull" ? fail("unauthorized for sk-live-abcdefghij") : args[0] === "info" ? ok("27") : fail("none")));
  const failed = (await run(pullFails).handle("sandbox.check", { pull: true })) as any;
  expect(failed.ok).toBe(false);
  expect(failed.problem).toContain("Could not pull");
  expect(failed.problem).not.toContain("sk-live");
});
