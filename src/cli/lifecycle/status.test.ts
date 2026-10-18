import { afterEach, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { resolveLayout, versionPath } from "../../install/layout";
import { emptyState, writeState } from "../../install/state";
import { fakeRunner, makeFixture, noDocker, type Fixture } from "../../doctor/testing";
import { fakeContext } from "./doctor.test";
import { runDashboard } from "./dashboard";
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
    dashboard: { url: "http://localhost:4399/" },
    providers: ["OpenAI"],
    docker: { ok: true },
    projects: { count: 2, default: "main" },
    paired: 2,
    cronJobs: 3,
    service: { manager: "launchd", running: true },
  });
  expect(s.lastSession).toBeTruthy();
  expect("web" in s).toBe(false);
  expect(ctx.stdout).not.toContain("TOKEN-VALUE");
  expect(ctx.stdout).not.toContain("sk-hidden-key");
});

test("status rows: dashboard, autonomy, telegram owner; no token anywhere; --all is accepted and changes nothing", async () => {
  fx = await makeFixture();
  const runner = await populated();
  await fx.write("gateway.json", JSON.stringify({ defaultProject: "main", chat: { autonomy: "balanced", backend: "host" }, telegram: { botToken: "123:bot-token-secret" } }));
  const plain = ctxFor();
  await runStatusCommand([], plain, { runner, checks: [] });
  const out = plain.stdout;
  const rows = out.split("\n").map((l) => l.trim().split(/\s{2,}/)[0]);
  expect(rows.slice(rows.indexOf("gateway"), rows.indexOf("gateway") + 4)).toEqual(["gateway", "dashboard", "telegram", "autonomy"]);
  expect(out).toMatch(/dashboard\s+http:\/\/localhost:4399\//);
  expect(out).toMatch(/autonomy\s+balanced \(commands run on this (Mac|computer)\)/);
  expect(out).toMatch(/telegram\s+bot set, no owner yet \(pick one in Settings → Channels & devices\)/);
  expect(out).toContain("3 jobs");
  expect(out).toContain("9.9.10 is installed, restart to use it");
  for (const secret of ["TOKEN-VALUE", "bot-token-secret", "token hidden"]) expect(out).not.toContain(secret);
  const all = ctxFor();
  expect(await runStatusCommand(["--all"], all, { runner, checks: [] })).toBe(0);
  expect(all.stdout).toBe(out);
  const help = fakeContext();
  await runStatusCommand(["--help"], help);
  expect(help.stdout).not.toContain("--all");
});

test("status --json: autonomy and telegram (with an owner); a dashboard that could not start says why", async () => {
  fx = await makeFixture();
  const runner = await populated();
  await fx.write("gateway.json", JSON.stringify({ chat: { autonomy: "autonomous", backend: "docker" } }));
  await fx.write("gateway/pairing.json", JSON.stringify({ version: 2, salt: "s".repeat(32), approved: [{ channel: "telegram", senderId: "7", approvedAt: 1 }], owner: { channel: "telegram", senderId: "7", since: 1 } }));
  await fx.write("gateway/state.json", JSON.stringify({ pid: 321, startedAt: "2026-10-15T08:00:00Z", webProblem: "Port 4317 is in use by node (pid 9)." }));
  const ctx = ctxFor();
  await runStatusCommand(["--json"], ctx, { runner, checks: [] });
  const s = JSON.parse(ctx.stdout) as Status;
  expect(s.autonomy).toEqual({ level: "autonomous", backend: "docker" });
  expect(s.telegram).toEqual({ token: false, owner: true });
  expect(s.dashboard).toEqual({ problem: "Port 4317 is in use by node (pid 9)." });
  const human = ctxFor();
  await runStatusCommand([], human, { runner, checks: [] });
  expect(human.stdout).toMatch(/autonomy\s+autonomous \(commands run in Docker\)/);
  expect(human.stdout).toMatch(/dashboard\s+off: Port 4317 is in use/);
  expect(human.stdout).toMatch(/telegram\s+no bot yet/);
});

test("a gateway running without the web UI: the dashboard row says so", async () => {
  fx = await makeFixture();
  await fx.write("gateway/state.json", JSON.stringify({ pid: 321, startedAt: "2026-10-15T08:00:00Z" }));
  const ctx = ctxFor();
  await runStatusCommand([], ctx, { runner: fakeRunner({ pidAlive: (p) => p === 321, exec: async () => noDocker }), checks: [] });
  expect(ctx.stdout).toMatch(/dashboard\s+off: the gateway runs without it/);
});

test("a gateway.json that does not parse: status still answers, with the defaults", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", "{ not json");
  const ctx = ctxFor();
  expect(await runStatusCommand(["--json"], ctx, { runner: fakeRunner({ exec: async () => noDocker }), checks: [] })).toBe(0);
  const s = JSON.parse(ctx.stdout) as Status;
  expect(s.autonomy).toEqual({ level: "balanced", backend: "host" });
  expect(s.dashboard).toBeNull();
});

test("every link the CLI prints is http://localhost", async () => {
  fx = await makeFixture();
  const runner = await populated();
  const outputs: string[] = [];
  for (const argv of [[], ["--json"]]) {
    const ctx = ctxFor();
    await runStatusCommand(argv, ctx, { runner, checks: [] });
    outputs.push(ctx.stdout);
  }
  const dash = ctxFor();
  expect(await runDashboard(["--no-open"], dash, { alive: (p) => p === 321 })).toBe(0);
  outputs.push(dash.stdout + dash.stderr);
  const code = ctxFor();
  expect(await runDashboard(["--code"], code, { alive: (p) => p === 321 })).toBe(0);
  outputs.push(code.stdout + code.stderr);
  for (const text of outputs) {
    expect(text).toContain("http://localhost:4399/");
    expect(text).not.toContain("127.0.0.1");
  }
});

test("the doctor summary counts errors and warnings read-only", async () => {
  fx = await makeFixture();
  const checks = [{ id: "x", area: "x", title: "x", run: async () => [{ id: "x1", level: "error" as const, message: "e" }, { id: "x2", level: "warn" as const, message: "w", fixable: true }] }];
  const ctx = ctxFor();
  await runStatusCommand(["--json"], ctx, { runner: fakeRunner(), checks });
  expect(JSON.parse(ctx.stdout).doctor).toEqual({ errors: 1, warnings: 1, fixable: 1 });
});
