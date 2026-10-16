import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { byId, makeFixture, runOne, type Fixture } from "../testing";
import { permissionsCheck } from "./permissions";

let fx: Fixture;
afterEach(() => fx?.close());

test("private files are fine", async () => {
  fx = await makeFixture();
  await fx.write("credentials.json", "{}", 0o600);
  const r = await runOne(fx, permissionsCheck);
  expect(r.findings.map((f) => f.level)).toEqual(["ok"]);
});

test("loose modes are warned about and chmod fixes them, without being told to ask", async () => {
  fx = await makeFixture();
  const cred = await fx.write("credentials.json", "{}", 0o644);
  const token = await fx.write("gateway/token", "x", 0o640);
  await chmod(join(fx.home, "gateway"), 0o755);
  const before = await runOne(fx, permissionsCheck);
  expect(before.summary.warn).toBe(3);
  expect(byId(before, "permissions.secrets.credentials.json")).toMatchObject({ fixable: true, safe: true });

  const after = await runOne(fx, permissionsCheck, { fix: "safe" });
  expect(after.summary).toMatchObject({ warn: 0, fixed: 3 });
  expect((await stat(cred)).mode & 0o777).toBe(0o600);
  expect((await stat(token)).mode & 0o777).toBe(0o600);
  expect((await stat(join(fx.home, "gateway"))).mode & 0o777).toBe(0o700);
});

test("a stricter mode than required is accepted", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", "{}", 0o400);
  expect((await runOne(fx, permissionsCheck)).summary.warn).toBe(0);
});

test("missing files are skipped and the home directory itself is checked", async () => {
  fx = await makeFixture();
  await mkdir(join(fx.home, "gateway"), { mode: 0o700 });
  await chmod(fx.home, 0o755);
  const r = await runOne(fx, permissionsCheck);
  expect(r.findings).toHaveLength(1);
  expect(r.findings[0]!.message).toContain(fx.home);
});
