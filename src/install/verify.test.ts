// src/install/verify.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeBinary, installDirect, makeFixtureRelease, type FixtureRelease } from "../../test/install/helpers/fixture-release";
import { makeTestKey, type TestKey } from "../../test/install/helpers/keys";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { ensureLayout, manifestDir, resolveLayout, versionPath, type Layout } from "./layout";
import { detectPlatform } from "./platform";
import { checkHealthy, checkVerified, defaultHealthCheck, isManaged, listManagedVersions, type VerifyContext } from "./verify";

let root: string;
let key: TestKey;
let r1: FixtureRelease;
let dir: string;
let l: Layout;
let ctx: VerifyContext;

beforeAll(async () => {
  root = await makeTmpDir();
  key = await makeTestKey(root, "k");
  r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root });
});
afterAll(() => removeDir(root));
beforeEach(async () => {
  dir = await makeTmpDir();
  l = resolveLayout({ HOME: dir });
  await ensureLayout(l);
  ctx = { layout: l, platform: detectPlatform(), trusted: key.trusted, health: defaultHealthCheck };
});

describe("Verified and Healthy", () => {
  test("a direct install is managed, Verified and Healthy", async () => {
    await installDirect(l, r1);
    expect(await isManaged(l, "1.0.0")).toBe(true);
    expect(await checkVerified(ctx, "1.0.0")).toEqual({ ok: true });
    expect(await checkHealthy(ctx, "1.0.0")).toEqual({ ok: true });
  });

  test("a modified binary is not Verified (unexpected file modification)", async () => {
    await installDirect(l, r1);
    await appendFile(versionPath(l, "1.0.0"), "\n# changed");
    expect(await checkVerified(ctx, "1.0.0")).toMatchObject({ ok: false });
  });

  test("a binary replaced by a symlink is not Verified", async () => {
    await installDirect(l, r1);
    await writeFile(join(dir, "elsewhere"), r1.binary);
    await rm(versionPath(l, "1.0.0"));
    await symlink(join(dir, "elsewhere"), versionPath(l, "1.0.0"));
    expect(await checkVerified(ctx, "1.0.0")).toEqual({ ok: false, reason: "is a symbolic link" });
  });

  test("a tampered stored manifest or a foreign key fails", async () => {
    await installDirect(l, r1);
    await appendFile(join(manifestDir(l, "1.0.0"), "manifest.json"), " ");
    expect((await checkVerified(ctx, "1.0.0")).ok).toBe(false);
    await installDirect(l, await makeFixtureRelease({ version: "1.0.1", key, dir: root }));
    expect((await checkVerified({ ...ctx, trusted: [] }, "1.0.1")).ok).toBe(false);
  });

  test("missing binary or manifest", async () => {
    expect(await checkVerified(ctx, "9.9.9")).toMatchObject({ ok: false });
    await installDirect(l, r1);
    await rm(versionPath(l, "1.0.0"));
    expect(await checkVerified(ctx, "1.0.0")).toEqual({ ok: false, reason: "missing" });
  });

  test("health check: exact output, exit 0, minimal environment, timeout", async () => {
    const bin = join(dir, "bin.sh");
    const write = async (body: string) => {
      await writeFile(bin, body);
      await chmod(bin, 0o755);
    };
    await write(fakeBinary("2.0.0"));
    expect(await defaultHealthCheck(bin, "2.0.0")).toBe("ok");
    expect(await defaultHealthCheck(bin, "2.0.1")).toBe("bad");
    await write('#!/bin/sh\necho "2.0.0 (Tropos Code)"; exit 3\n');
    expect(await defaultHealthCheck(bin, "2.0.0")).toBe("bad");
    await write('#!/bin/sh\n[ -n "$ANTHROPIC_API_KEY" ] && exit 9\necho "2.0.0 (Tropos Code)"\n');
    expect(await defaultHealthCheck(bin, "2.0.0", { ...process.env, ANTHROPIC_API_KEY: "secret" })).toBe("ok");
    await write("#!/bin/sh\nsleep 5\n");
    expect(await defaultHealthCheck(bin, "2.0.0", process.env, 200)).toBe("unknown");
    expect(await defaultHealthCheck(join(dir, "missing"), "2.0.0")).toBe("bad");
  });

  test("health check: a transient spawn failure or a timeout is unknown, retried once; other spawn errors are bad", async () => {
    const failing = (code: string) => {
      let calls = 0;
      const spawn = (() => {
        calls++;
        throw Object.assign(new Error(code), { code });
      }) as unknown as typeof Bun.spawn;
      return { spawn, calls: () => calls };
    };
    for (const code of ["EAGAIN", "ENOMEM", "EMFILE"]) {
      const s = failing(code);
      expect(await defaultHealthCheck("/bin/sh", "2.0.0", process.env, 1000, s.spawn)).toBe("unknown");
      expect(s.calls()).toBe(2);
    }
    const eacces = failing("EACCES");
    expect(await defaultHealthCheck("/bin/sh", "2.0.0", process.env, 1000, eacces.spawn)).toBe("bad");
    expect(eacces.calls()).toBe(1);

    // A transient first attempt followed by a real verdict reports the verdict.
    const bin = join(dir, "flaky.sh");
    await writeFile(bin, fakeBinary("2.0.0"));
    await chmod(bin, 0o755);
    let n = 0;
    const flaky = ((...args: Parameters<typeof Bun.spawn>) => {
      if (n++ === 0) throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
      return Bun.spawn(...args);
    }) as typeof Bun.spawn;
    expect(await defaultHealthCheck(bin, "2.0.0", process.env, 5000, flaky)).toBe("ok");
  });

  test("checkHealthy marks only an inconclusive health check as transient", async () => {
    await installDirect(l, r1);
    expect(await checkHealthy({ ...ctx, health: async () => "unknown" }, "1.0.0")).toEqual({ ok: false, reason: "its health check could not be run", transient: true });
    expect(await checkHealthy({ ...ctx, health: async () => "bad" }, "1.0.0")).toEqual({ ok: false, reason: "failed its health check", transient: false });
    await appendFile(versionPath(l, "1.0.0"), "x");
    expect(await checkHealthy({ ...ctx, health: async () => "unknown" }, "1.0.0")).toMatchObject({ ok: false, transient: false });
  });

  test("listings ignore non-version names and sort newest first", async () => {
    await installDirect(l, r1);
    await installDirect(l, await makeFixtureRelease({ version: "1.10.0", key, dir: root }));
    await writeFile(join(l.versions, ".corrupt-1.0.0-1"), "");
    await writeFile(join(l.versions, "0.1.0"), "local build");
    expect(await listManagedVersions(l)).toEqual(["1.10.0", "1.0.0"]);
  });

  test("a manifest dir without manifest.json is not managed", async () => {
    await installDirect(l, r1);
    await mkdir(manifestDir(l, "1.5.0"), { recursive: true });
    await writeFile(join(manifestDir(l, "1.5.0"), "manifest.json.sig"), "sig");
    expect(await isManaged(l, "1.5.0")).toBe(false);
    expect(await listManagedVersions(l)).toEqual(["1.0.0"]);
  });
});
