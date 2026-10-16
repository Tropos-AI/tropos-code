import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runDashboard } from "./dashboard";
import { makeFixture, type Fixture } from "./lifecycle-fixture";

let fx: Fixture;
afterEach(() => fx?.cleanup());

async function running(webPort = 4321, token = "t".repeat(40)) {
  await mkdir(join(fx.ctx.home, "gateway"), { recursive: true });
  await writeFile(join(fx.ctx.home, "gateway", "state.json"), JSON.stringify({ pid: 4242, webPort }));
  if (token) await writeFile(join(fx.ctx.home, "gateway", "token"), `${token}\n`);
}
const alive = (pid: number) => pid === 4242;

test("opens the link with the persistent token and prints it without the token", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard([], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  expect(opened).toEqual([`http://127.0.0.1:4321/?token=${"t".repeat(40)}`]);
  expect(fx.stdout()).toContain("http://127.0.0.1:4321/");
  expect(fx.stdout()).not.toContain("t".repeat(40));
});

test("--print-url prints the link and warns that it is a secret, without opening", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard(["--print-url"], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  expect(fx.stdout()).toBe(`http://127.0.0.1:4321/?token=${"t".repeat(40)}\n`);
  expect(fx.stderr()).toContain("secret");
  expect(opened).toEqual([]);
});

test("--no-open opens nothing and does not print the key", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard(["--no-open"], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  expect(opened).toEqual([]);
  expect(fx.stdout()).not.toContain("t".repeat(40));
});

test("a dead pid or no web port means not running: explains, exit 1 without a terminal", async () => {
  fx = await makeFixture();
  await running();
  expect(await runDashboard([], fx.ctx, { alive: () => false })).toBe(1);
  expect(fx.stdout()).toContain("tcode gateway install");
  expect(fx.stderr()).toContain("not running");
});

test("not running with a terminal offers tcode web in the foreground", async () => {
  fx = await makeFixture({ interactive: true, answers: [true] });
  let started = 0;
  expect(await runDashboard([], fx.ctx, { alive, startWeb: async () => (started++, 0) })).toBe(0);
  expect(started).toBe(1);
  expect(fx.asked[0]).toContain("tcode web");
  fx = await makeFixture({ interactive: true, answers: [false] });
  expect(await runDashboard([], fx.ctx, { alive, startWeb: async () => 0 })).toBe(1);
});

test("a gateway without a token file is reported instead of opening a link that cannot sign in", async () => {
  fx = await makeFixture();
  await running(4321, "");
  expect(await runDashboard([], fx.ctx, { alive, openBrowser: () => { throw new Error("no"); } })).toBe(1);
  expect(await runDashboard(["--print-url"], fx.ctx, { alive })).toBe(1);
});

test("usage errors are 64", async () => {
  fx = await makeFixture();
  expect(await runDashboard(["--bogus"], fx.ctx)).toBe(64);
  expect(await runDashboard(["x"], fx.ctx)).toBe(64);
  expect(await runDashboard(["--help"], fx.ctx)).toBe(0);
});
