import { afterEach, expect, test } from "bun:test";
import { chmod, stat } from "node:fs/promises";
import { fakeRunner, makeFixture, type Fixture } from "../../doctor/testing";
import { fakeContext } from "./doctor.test";
import { runSecurityCommand } from "./security";

let fx: Fixture;
afterEach(() => fx?.close());
const ctxFor = () => fakeContext({ env: { ...fx.env }, home: fx.home, userHome: fx.userHome, cwd: fx.root });

test("--help, usage errors", async () => {
  const ctx = fakeContext();
  expect(await runSecurityCommand(["--help"], ctx)).toBe(0);
  expect(ctx.stdout).toContain("tcode security audit");
  for (const argv of [[], ["scan"], ["audit", "extra"], ["audit", "--bogus"]]) expect(await runSecurityCommand(argv, fakeContext())).toBe(64);
});

test("audit reports the security area and the secret-file permissions, not the rest of the doctor", async () => {
  fx = await makeFixture();
  await fx.write("credentials.json", "{}", 0o644);
  await fx.write("gateway.json", JSON.stringify({ sandbox: { network: "bridge" } }));
  const ctx = ctxFor();
  const code = await runSecurityCommand(["audit"], ctx, { runner: fakeRunner() });
  expect(code).toBe(0);
  expect(ctx.stdout).toContain("Tropos security audit");
  expect(ctx.stdout).toContain("security");
  expect(ctx.stdout).toContain("permissions");
  expect(ctx.stdout).toContain("network access");
  expect(ctx.stdout).not.toContain("docker");
  expect(ctx.stdout).toContain("tcode security audit --fix");
});

test("--fix only chmods", async () => {
  fx = await makeFixture();
  const cred = await fx.write("credentials.json", "{}", 0o644);
  const gw = await fx.write("gateway.json", JSON.stringify({ sandbox: { network: "bridge" } }), 0o600);
  const ctx = ctxFor();
  await runSecurityCommand(["audit", "--fix"], ctx, { runner: fakeRunner() });
  expect((await stat(cred)).mode & 0o777).toBe(0o600);
  expect(await Bun.file(gw).text()).toContain("bridge");
});

test("--json, and an error (home as a project) exits 1", async () => {
  fx = await makeFixture();
  await chmod(fx.home, 0o700);
  const runner = fakeRunner({ listProjects: async () => [{ id: "home", name: "home", path: fx.userHome }] });
  const ctx = ctxFor();
  expect(await runSecurityCommand(["audit", "--json"], ctx, { runner })).toBe(1);
  expect(JSON.parse(ctx.stdout).summary.error).toBe(1);
});

test("--deep adds the Telegram token check", async () => {
  fx = await makeFixture();
  const seen: string[] = [];
  const fetch = (async (u: string) => (seen.push(String(u)), new Response(JSON.stringify({ ok: true, result: { username: "b" } })))) as unknown as typeof globalThis.fetch;
  const ctx = fakeContext({ env: { ...fx.env, TROPOS_TELEGRAM_BOT_TOKEN: "1:t" }, home: fx.home, userHome: fx.userHome, cwd: fx.root });
  await runSecurityCommand(["audit", "--deep"], ctx, { runner: fakeRunner({ fetch }) });
  expect(seen).toHaveLength(1);
  expect(ctx.stdout).not.toContain("1:t");
});
