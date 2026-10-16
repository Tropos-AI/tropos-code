import { afterEach, expect, test } from "bun:test";
import { fakeRunner, makeFixture, noDocker, runOne, type Fixture } from "../testing";
import { containersCheck } from "./containers";

let fx: Fixture;
afterEach(() => fx?.close());

const ps = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

test("no daemon: nothing to report", async () => {
  fx = await makeFixture();
  expect((await runOne(fx, containersCheck, { runner: fakeRunner({ exec: async () => noDocker }) })).findings).toEqual([]);
});

test("containers whose owner is alive are not leftovers", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, containersCheck, { runner: fakeRunner({ exec: ps("c1 100\n"), pidAlive: (p) => p === 100 }) });
  expect(r.findings[0]!.level).toBe("ok");
});

test("dead and unlabelled owners are leftovers; --fix sweeps", async () => {
  fx = await makeFixture();
  let swept = 0;
  const runner = fakeRunner({ exec: ps("c1 100\nc2 200\nc3\n"), pidAlive: (p) => p === 100, sweepContainers: async () => ++swept });
  const plain = await runOne(fx, containersCheck, { runner });
  expect(plain.findings[0]).toMatchObject({ level: "warn", fixable: true });
  expect(plain.findings[0]!.message).toContain("2 leftover");
  expect(swept).toBe(0);
  const fixed = await runOne(fx, containersCheck, { runner, fix: true });
  expect(swept).toBe(1);
  expect(fixed.findings[0]!.fixed).toBe(true);
});
