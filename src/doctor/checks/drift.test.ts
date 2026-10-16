import { afterEach, expect, test } from "bun:test";
import { makeFixture, runOne, type Fixture } from "../testing";
import { driftCheck } from "./drift";

let fx: Fixture;
afterEach(() => fx?.close());

test("the old workspace key without projects is drift (report only)", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", JSON.stringify({ workspace: "/code/app" }));
  const r = await runOne(fx, driftCheck, { fix: true });
  expect(r.findings[0]).toMatchObject({ level: "warn" });
  expect(r.findings[0]!.fixable).toBeUndefined();
  expect(r.findings[0]!.detail).toContain("tcode migrate");
});

test("projects present, no file, or a broken file are not drift", async () => {
  fx = await makeFixture();
  expect((await runOne(fx, driftCheck)).findings[0]!.level).toBe("ok");
  await fx.write("gateway.json", JSON.stringify({ workspace: "/x", projects: [] }));
  expect((await runOne(fx, driftCheck)).findings[0]!.level).toBe("ok");
  await fx.write("gateway.json", "{bad");
  expect((await runOne(fx, driftCheck)).findings[0]!.level).toBe("ok");
});
