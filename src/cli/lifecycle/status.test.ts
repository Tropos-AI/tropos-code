import { afterEach, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { resolveLayout, versionPath } from "../../install/layout";
import { emptyState, writeState } from "../../install/state";
import { fakeRunner, makeFixture, noDocker, type Fixture } from "../../doctor/testing";
import { fakeContext } from "./doctor.test";
import { runStatusCommand, type Status } from "./status";

let fx: Fixture;
afterEach(() => fx?.close());
const ctxFor = () => fakeContext({ env: { ...fx.env }, home: fx.home, userHome: fx.userHome, cwd: fx.root });

test("--help and usage errors", async () => {
  const ctx = fakeContext();
  expect(await runStatusCommand(["--help"], ctx)).toBe(0);
  expect(ctx.stdout).toContain("tcode status");
  expect(await runStatusCommand(["--nope"], fakeContext())).toBe(64);
  expect(await runStatusCommand(["word"], fakeContext())).toBe(64);
});

test("an empty install says so without failing", async () => {
  fx = await makeFixture();
  const ctx = ctxFor();
  expect(await runStatusCommand([], ctx, { runner: fakeRunner({ exec: async () => noDocker }), checks: [] })).toBe(0);
  expect(ctx.stdout).toContain("Tropos Code 9.9.9 (channel latest)");
  expect(ctx.stdout).toContain("not running");
  expect(ctx.stdout).toContain("none connected");
  expect(ctx.stdout).toContain("none yet");
  expect(ctx.stdout).not.toContain("scheduled");
});

async function populated() {
  const l = resolveLayout(fx.env, fx.userHome);
  for (const d of [l.versions, l.state, l.binDir, l.locks, l.manifests]) await mkdir(d, { recursive: true });
  await mkdir(versionPath(l, "9.9.9"));
  await mkdir(versionPath(l, "9.9.10"));
  await writeState(l, { ...emptyState(), current: "9.9.9", previous: "9.9.8" });
  await symlink(versionPath(l, "9.9.9"), l.binLink);
  await fx.write("gateway/state.json", JSON.stringify({ pid: 321, startedAt: "2026-10-15T08:00:00Z", webPort: 4399 }));
  await fx.write("gateway/token", "TOKEN-VALUE-1234567890123456789012345\n");
  await fx.write("gateway/pairing.json", JSON.stringify({ approved: [{ channel: "t", senderId: "1", approvedAt: 1 }, { channel: "t", senderId: "2", approvedAt: 2 }] }));
  await fx.write("gateway/cron/jobs.json", JSON.stringify({ jobs: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
  await fx.write("gateway.json", JSON.stringify({ defaultProject: "main" }));
  await fx.write("credentials.json", JSON.stringify({ openai: { apiKey: "sk-hidden-key" } }));
  await fx.write("projects/p1/aaaa.jsonl", "{}\n");
  return fakeRunner({
    pidAlive: (p) => p === 321,
    exec: async () => ({ code: 0, stdout: "27.1\n", stderr: "" }),
    serviceStatus: async () => ({ manager: "launchd", installed: true, running: true, pid: 321 }),
    listProjects: async () => [{ id: "main", name: "main", path: fx.root }, { id: "b", name: "b", path: fx.root }],
  });
}

test("--json gathers everything, hides the token and never prints keys", async () => {
  fx = await makeFixture();
  const runner = await populated();
  const ctx = ctxFor();
  expect(await runStatusCommand(["--json"], ctx, { runner, checks: [] })).toBe(0);
  const s = JSON.parse(ctx.stdout) as Status;
  expect(s).toMatchObject({
    version: "9.9.9",
    install: { current: "9.9.9", previous: "9.9.8", updateReady: "9.9.10" },
    gateway: { running: true, pid: 321 },
    web: { url: "http://127.0.0.1:4399/" },
    providers: ["OpenAI"],
    docker: { ok: true },
    projects: { count: 2, default: "main" },
    paired: 2,
    cronJobs: 3,
    service: { manager: "launchd", running: true },
  });
  expect(s.lastSession).toBeTruthy();
  expect(ctx.stdout).not.toContain("TOKEN-VALUE");
  expect(ctx.stdout).not.toContain("sk-hidden-key");
});

test("--all shows the web link's token; the human view is readable", async () => {
  fx = await makeFixture();
  const runner = await populated();
  const hidden = ctxFor();
  await runStatusCommand([], hidden, { runner, checks: [] });
  expect(hidden.stdout).toContain("token hidden");
  expect(hidden.stdout).toContain("3 jobs");
  expect(hidden.stdout).toContain("9.9.10 is installed, restart to use it");
  const shown = ctxFor();
  await runStatusCommand(["--all"], shown, { runner, checks: [] });
  expect(shown.stdout).toContain("http://127.0.0.1:4399/?token=TOKEN-VALUE");
});

test("the doctor summary counts errors and warnings read-only", async () => {
  fx = await makeFixture();
  const checks = [{ id: "x", area: "x", title: "x", run: async () => [{ id: "x1", level: "error" as const, message: "e" }, { id: "x2", level: "warn" as const, message: "w", fixable: true }] }];
  const ctx = ctxFor();
  await runStatusCommand(["--json"], ctx, { runner: fakeRunner(), checks });
  expect(JSON.parse(ctx.stdout).doctor).toEqual({ errors: 1, warnings: 1, fixable: 1 });
});
