import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeRunner, makeFixture, runOne, type Fixture } from "../testing";
import { gatewayStateCheck } from "./gateway-state";

let fx: Fixture;
afterEach(() => fx?.close());

test("no state file: not running", async () => {
  fx = await makeFixture();
  expect((await runOne(fx, gatewayStateCheck)).findings[0]).toMatchObject({ level: "ok", message: expect.stringContaining("not running") });
});

test("a live pid is ok", async () => {
  fx = await makeFixture();
  await fx.write("gateway/state.json", JSON.stringify({ pid: 4242, webPort: 4317, telegram: false }));
  const r = await runOne(fx, gatewayStateCheck, { runner: fakeRunner({ pidAlive: (p) => p === 4242 }) });
  expect(r.findings[0]!.message).toContain("pid 4242");
});

test("a dead pid is stale; the safe fix removes the file", async () => {
  fx = await makeFixture();
  const path = await fx.write("gateway/state.json", JSON.stringify({ pid: 4242 }));
  const r = await runOne(fx, gatewayStateCheck, { fix: "safe" });
  expect(r.findings[0]).toMatchObject({ fixed: true });
  expect(existsSync(path)).toBe(false);
});

test("an unreadable state file is also removed by the fix", async () => {
  fx = await makeFixture();
  await fx.write("gateway/state.json", "not json");
  const plain = await runOne(fx, gatewayStateCheck);
  expect(plain.findings[0]).toMatchObject({ level: "warn", fixable: true, safe: true });
  await runOne(fx, gatewayStateCheck, { fix: "safe" });
  expect(existsSync(join(fx.home, "gateway", "state.json"))).toBe(false);
});
