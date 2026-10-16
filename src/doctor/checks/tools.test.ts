import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { byId, makeFixture, runOne, type Fixture } from "../testing";
import { toolsCheck } from "./tools";

let fx: Fixture;
afterEach(() => fx?.close());

test("git missing warns, ripgrep missing is only info", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, toolsCheck);
  expect(byId(r, "tools.git")!.level).toBe("warn");
  expect(byId(r, "tools.ripgrep")!.level).toBe("info");
});

test("both found on PATH", async () => {
  fx = await makeFixture();
  const bin = join(fx.root, "bin");
  await mkdir(bin);
  for (const n of ["git", "rg"]) {
    await writeFile(join(bin, n), "");
    await chmod(join(bin, n), 0o755);
  }
  const r = await runOne(fx, toolsCheck, { env: { ...fx.env, PATH: bin } });
  expect(r.findings.map((f) => f.level)).toEqual(["ok", "ok"]);
});
