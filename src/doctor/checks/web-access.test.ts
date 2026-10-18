import { afterEach, expect, test } from "bun:test";
import { fakeRunner, makeFixture, runOne, type Fixture } from "../testing";
import { webAccessCheck } from "./web-access";

let fx: Fixture;
afterEach(() => fx?.close());
const alive = fakeRunner({ pidAlive: (p) => p === 4242 });

test("running with a port: ok", async () => {
  fx = await makeFixture();
  await fx.write("gateway/state.json", JSON.stringify({ pid: 4242, webPort: 4317 }));
  const r = await runOne(fx, webAccessCheck, { runner: alive });
  expect(r.findings[0]).toMatchObject({ id: "gateway.web", level: "ok", message: expect.stringContaining("4317") });
});

test("state.json carries webProblem: warn with that text", async () => {
  fx = await makeFixture();
  await fx.write("gateway/state.json", JSON.stringify({ pid: 4242, webProblem: "Port 4317 is in use by node (pid 9)." }));
  const r = await runOne(fx, webAccessCheck, { runner: alive });
  expect(r.findings[0]).toMatchObject({ level: "warn", message: expect.stringContaining("Port 4317 is in use by node (pid 9).") });
});

test("not running and the configured port is held by someone: warn naming the holder", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", JSON.stringify({ webPort: 4555 }));
  const runner = fakeRunner({ exec: async (cmd) => (cmd === "lsof" ? { code: 0, stdout: "p812\ncpython3\n", stderr: "" } : { code: null, stdout: "", stderr: "", error: "x" }) });
  const r = await runOne(fx, webAccessCheck, { runner });
  expect(r.findings[0]!.level).toBe("warn");
  expect(r.findings[0]!.message).toContain("python3 (pid 812)");
  expect(r.findings[0]!.message).toContain("4555");
  
});

test("not running and the port is free: ok", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, webAccessCheck);
  expect(r.findings[0]).toMatchObject({ level: "ok" });
});
