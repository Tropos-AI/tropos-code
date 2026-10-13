// test/install/concurrency.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installTarget } from "../../src/install/installer";
import { readLink } from "../../src/install/link";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

async function child(op: "install" | "cleanup", target?: string): Promise<{ code: number; result: unknown }> {
  const config = join(f.root, `c-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(config, JSON.stringify({ home: f.home, base: f.srv.base, signers: f.key.signersLine, op, target }));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "helpers/crash-child.ts"), config], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, result: JSON.parse(out.trim().split("\n").at(-1)!) };
}

describe("concurrency (spec §13 layer 3)", () => {
  test("two installs at once: one installs, the other waits and finds nothing to do", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    const [a, b] = await Promise.all([child("install", "1.0.0"), child("install", "1.0.0")]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const changed = [a, b].map((r) => (r.result as { changed: boolean }).changed);
    expect(changed.filter(Boolean).length).toBe(1);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });

  test("cleanup keeps a version another process is running, and removes it once that process exits (R5.4)", async () => {
    f = await makeEngineFixture();
    for (const v of ["0.7.0", "0.8.0", "0.9.0", "1.0.0"]) await f.release(v);
    for (const v of ["0.7.0", "0.8.0", "0.9.0"]) await installTarget(f.deps, v, false);
    const holder = Bun.spawn(["bun", join(import.meta.dir, "helpers/hold-lock.ts"), join(f.layout.locks, "0.7.0.lock"), "sh"], { stdout: "pipe" });
    await holder.stdout.getReader().read();
    await installTarget(f.deps, "1.0.0", false); // its cleanup must keep the held 0.7.0
    expect(await readdir(f.layout.versions)).toContain("0.7.0");
    expect((await child("cleanup")).result).toEqual([]);
    holder.kill("SIGKILL");
    await holder.exited;
    expect((await child("cleanup")).result).toEqual(["0.7.0"]);
  });
});
