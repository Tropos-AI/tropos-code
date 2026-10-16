import { afterEach, expect, test } from "bun:test";
import { makeFixture, runOne, type Fixture } from "../testing";
import { SESSIONS_WARN_BYTES, sessionsCheck } from "./sessions";

let fx: Fixture;
afterEach(() => fx?.close());

test("the default limit is 1 GiB", () => {
  expect(SESSIONS_WARN_BYTES).toBe(1024 ** 3);
});

test("small sessions are ok, even with none", async () => {
  fx = await makeFixture();
  expect((await runOne(fx, sessionsCheck())).findings[0]).toMatchObject({ level: "ok", message: "Sessions use 0 B" });
});

test("over the limit warns and says where they are", async () => {
  fx = await makeFixture();
  await fx.write("projects/a/s1.jsonl", "x".repeat(600));
  await fx.write("projects/b/s2.jsonl", "y".repeat(600));
  const r = await runOne(fx, sessionsCheck(1000));
  expect(r.findings[0]!.level).toBe("warn");
  expect(r.findings[0]!.detail).toContain("tcode backup");
  expect((await runOne(fx, sessionsCheck(2000))).findings[0]!.level).toBe("ok");
});
