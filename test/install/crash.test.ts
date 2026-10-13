// test/install/crash.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup } from "../../src/install/cleanup";
import { withInstallLock } from "../../src/install/engine";
import { installTarget } from "../../src/install/installer";
import { readLink } from "../../src/install/link";
import { readState } from "../../src/install/state";
import { checkHealthy } from "../../src/install/verify";
import { verifyContext } from "../../src/install/engine";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

async function runChild(op: "install" | "rollback" | "cleanup", crashAt: string, target?: string) {
  const config = join(f.root, `child-${crashAt}.json`);
  await writeFile(config, JSON.stringify({ home: f.home, base: f.srv.base, signers: f.key.signersLine, op, target, crashAt }));
  const child = Bun.spawn(["bun", join(import.meta.dir, "helpers/crash-child.ts"), config], { stdout: "pipe", stderr: "pipe" });
  await child.exited;
  return child;
}

/** The invariant of spec §10.6: our link is absent or points at a Healthy version; state agrees; nothing pending. */
async function assertConsistent(allowAbsent: boolean) {
  const report = await f.recoverNow();
  const link = await readLink(f.layout);
  const read = await readState(f.layout);
  const state = read.kind === "ok" ? read.state : null;
  if (link.kind === "missing") {
    expect(allowAbsent).toBe(true);
    expect(state?.current ?? null).toBeNull();
  } else {
    expect(link.kind).toBe("ours");
    const v = (link as { version: string }).version;
    expect(await checkHealthy(verifyContext(f.deps), v)).toEqual({ ok: true });
    expect(state?.current).toBe(v);
  }
  expect(state?.pending ?? null).toBeNull();
  await withInstallLock({ ...f.deps, now: () => new Date(Date.now() + 2 * 3_600_000) }, { wait: true }, (s) => cleanup(s));
  expect(await readdir(f.layout.staging)).toEqual([]);
  return { report, link, state };
}

const POINTS = ["after-download", "after-rename", "after-pending", "after-swap", "after-state"] as const;

describe("SIGKILL during an upgrade (R6.x)", () => {
  const expected: Record<(typeof POINTS)[number], string> = {
    "after-download": "1.0.0",
    "after-rename": "1.0.0",
    "after-pending": "1.0.0",
    "after-swap": "1.1.0",
    "after-state": "1.1.0",
  };
  for (const point of POINTS) {
    test(point, async () => {
      f = await makeEngineFixture();
      await f.release("1.0.0");
      await f.release("1.1.0");
      await installTarget(f.deps, "1.0.0", false);
      const child = await runChild("install", point, "1.1.0");
      expect(child.signalCode).toBe("SIGKILL");
      const { state } = await assertConsistent(false);
      expect(state!.current).toBe(expected[point]);
    });
  }
});

describe("SIGKILL during a first install (R6.1)", () => {
  for (const point of POINTS) {
    test(point, async () => {
      f = await makeEngineFixture();
      await f.release("1.1.0");
      const child = await runChild("install", point, "1.1.0");
      expect(child.signalCode).toBe("SIGKILL");
      const { link, report } = await assertConsistent(true);
      if (point === "after-pending") expect(report.fatal).toBe("installation did not complete; run install.sh again");
      if (point === "after-swap" || point === "after-state") expect(link).toEqual({ kind: "ours", version: "1.1.0" });
      else expect(link).toEqual({ kind: "missing" });
    });
  }
});

describe("SIGKILL during rollback and cleanup", () => {
  test.each(["after-pending", "after-swap", "after-state"])("rollback %s", async (point) => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    await installTarget(f.deps, "1.1.0", false);
    expect((await runChild("rollback", point)).signalCode).toBe("SIGKILL");
    await assertConsistent(false);
  });

  test("mid-cleanup", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["0.7.0", "0.8.0", "0.9.0", "1.0.0"], current: "1.0.0", previous: "0.9.0", link: "1.0.0" });
    expect((await runChild("cleanup", "mid-cleanup")).signalCode).toBe("SIGKILL");
    await assertConsistent(false);
    expect(await readdir(f.layout.versions)).not.toContain("0.7.0");
  });

  test("a torn install.json is rebuilt", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await writeFile(f.layout.stateFile, '{"schema": 1, "gen');
    const { state } = await assertConsistent(false);
    expect(state!.current).toBe("1.0.0");
  });
});
