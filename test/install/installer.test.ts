// test/install/installer.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InstallError } from "../../src/install/errors";
import { installSelf, installTarget, updateChannel } from "../../src/install/installer";
import { versionPath } from "../../src/install/layout";
import { readLink } from "../../src/install/link";
import { lockVersionShared } from "../../src/install/locks";
import { writeState } from "../../src/install/state";
import { fakeBinary } from "./helpers/fixture-release";
import { makeTestKey, sshSign } from "./helpers/keys";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as InstallError;

describe("install from the network", () => {
  test("first install of an explicit version via the zst asset", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    const { value } = await installTarget(f.deps, "1.0.0", false);
    expect(value).toEqual({ version: "1.0.0", previous: null, changed: true });
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", previous: null, pending: null });
    expect(f.srv.requests.some((r) => r.endsWith(".zst"))).toBe(true);
    expect((await stat(versionPath(f.layout, "1.0.0"))).mode & 0o777).toBe(0o755);
    expect(await readdir(f.layout.staging)).toEqual([]);
  });

  test("installs under a layout path with spaces (Review Focus 2)", async () => {
    f = await makeEngineFixture();
    expect(f.home).toContain(" ");
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });

  test("resolves a channel, upgrades and records previous", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "latest", "1.1.0\n");
    const { value } = await installTarget(f.deps, "latest", false);
    expect(value).toEqual({ version: "1.1.0", previous: "1.0.0", changed: true });
    expect(await f.state()).toMatchObject({ current: "1.1.0", previous: "1.0.0" });
  });

  test("reinstalling the current version is a no-op without network access", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    const before = f.srv.requests.length;
    expect((await installTarget(f.deps, "1.0.0", false)).value.changed).toBe(false);
    expect(f.srv.requests.length).toBe(before);
  });

  test("falls back to the raw asset when the zst is corrupt", async () => {
    f = await makeEngineFixture();
    const r = await f.release("1.0.0");
    f.srv.put("v1.0.0", `tropos-${f.deps.platform}.zst`, r.zst.subarray(0, 10));
    await installTarget(f.deps, "1.0.0", false);
    expect(f.srv.requests.some((p) => p.endsWith(`/tropos-${f.deps.platform}`))).toBe(true);
  });

  test("a raw asset that never matches fails with integrity after 3 tries; nothing activated", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    f.srv.put("v1.0.0", `tropos-${f.deps.platform}.zst`, "junk");
    f.srv.put("v1.0.0", `tropos-${f.deps.platform}`, "not the binary");
    const e = await err(installTarget(f.deps, "1.0.0", false));
    expect(e.kind).toBe("integrity");
    expect(await readLink(f.layout)).toEqual({ kind: "missing" });
    expect(await readdir(f.layout.staging)).toEqual([]);
  });

  test("a release that fails its health check is skipped and never activated", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await f.release("1.1.0", "#!/bin/sh\nexit 1\n");
    const e = await err(installTarget(f.deps, "1.1.0", false));
    expect(e.message).toBe("release 1.1.0 does not run on this machine");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect((await f.state()).skip).toEqual({ "1.1.0": "health-check" });
  });

  test("a foreign ~/.local/bin/tropos needs --force", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await writeFile(f.layout.binLink, "#!/bin/sh\n");
    expect((await err(installTarget(f.deps, "1.0.0", false))).message).toContain("is not managed by Tropos");
    await installTarget(f.deps, "1.0.0", true);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });

  test("replaces an unmanaged symlink into versions/ without --force (Review Focus 3)", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await writeFile(versionPath(f.layout, "0.1.0"), "local build");
    await symlink(versionPath(f.layout, "0.1.0"), f.layout.binLink);
    await installTarget(f.deps, "1.0.0", false);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await readFile(versionPath(f.layout, "0.1.0"), "utf8")).toBe("local build");
    expect((await f.state()).previous).toBeNull();
  });

  test("an unmanaged local build with a release's version number is moved aside, never deleted (A9)", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await writeFile(versionPath(f.layout, "1.0.0"), "local build of 1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    expect((await readdir(f.layout.versions)).some((n) => n.startsWith(".unmanaged-1.0.0-"))).toBe(true);
  });

  test("versions/<v> planted as a symlink is never followed or trusted", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    const decoy = join(f.root, "decoy");
    await writeFile(decoy, "decoy");
    await symlink(decoy, versionPath(f.layout, "1.0.0"));
    await installTarget(f.deps, "1.0.0", false);
    expect(await readFile(decoy, "utf8")).toBe("decoy");
    expect((await stat(versionPath(f.layout, "1.0.0"))).isFile()).toBe(true);
  });

  test("world-writable bin directory is refused", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await chmod(f.layout.binDir, 0o777);
    expect((await err(installTarget(f.deps, "1.0.0", false))).kind).toBe("local");
  });
});

describe("--force and damaged versions (R5.1–R5.3)", () => {
  test("--force on the current version keeps the verified file (same inode) and re-checks it", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    const inode = (await stat(versionPath(f.layout, "1.0.0"))).ino;
    let healthChecks = 0;
    const deps = { ...f.deps, health: async (b: string, v: string) => (healthChecks++, f.deps.health(b, v)) };
    expect((await installTarget(deps, "1.0.0", true)).value.version).toBe("1.0.0");
    expect((await stat(versionPath(f.layout, "1.0.0"))).ino).toBe(inode);
    expect(healthChecks).toBeGreaterThan(0);
  });

  test("a damaged version in use is not touched; the link moves to a healthy fallback; exit busy", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    await installTarget(f.deps, "1.1.0", false);
    const session = (await lockVersionShared(f.layout, "1.1.0"))!;
    await appendFile(versionPath(f.layout, "1.1.0"), "damage");
    const damaged = await readFile(versionPath(f.layout, "1.1.0"));
    // Recovery (run first) already moves the link; the install then refuses to replace the file in use.
    const e = await err(installTarget(f.deps, "1.1.0", true));
    expect(e.kind).toBe("busy");
    expect(await readFile(versionPath(f.layout, "1.1.0"))).toEqual(damaged);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    session.release();
  });

  test("a damaged version not in use is quarantined and replaced", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await appendFile(versionPath(f.layout, "1.0.0"), "damage");
    await installTarget(f.deps, "1.0.0", true);
    expect((await readdir(f.layout.versions)).some((n) => n.startsWith(".corrupt-1.0.0-"))).toBe(true);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });
});

describe("install --self (R1.1–R1.3)", () => {
  async function selfSource(version: string, opts: { tamperBinary?: boolean; untrusted?: boolean; manifestVersion?: string } = {}) {
    const r = await f.release(opts.manifestVersion ?? version);
    const tmp = join(f.root, `tmp-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp);
    const exe = join(tmp, "tropos");
    await writeFile(exe, opts.tamperBinary ? fakeBinary(version, "# tampered") : r.binary);
    await chmod(exe, 0o700);
    await writeFile(join(tmp, "manifest.json"), r.verified.bytes);
    const sig = opts.untrusted ? await sshSign(await makeTestKey(f.root, `u${Date.now()}`), r.verified.bytes, "tropos-manifest", f.root) : r.verified.signature;
    await writeFile(join(tmp, "manifest.json.sig"), sig);
    return { kind: "self" as const, execPath: exe, manifestPath: join(tmp, "manifest.json"), signaturePath: join(tmp, "manifest.json.sig"), compiledVersion: version };
  }

  test("installs from a verified temporary executable outside $DATA", async () => {
    f = await makeEngineFixture();
    const { value } = await installSelf(f.deps, await selfSource("1.0.0"));
    expect(value.version).toBe("1.0.0");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(f.srv.requests.filter((r) => r.includes("/tropos-")).length).toBe(0);
  });

  test.each([
    ["a binary whose bytes differ from the manifest", { tamperBinary: true }, "integrity"],
    ["a signature from an untrusted key", { untrusted: true }, "integrity"],
    ["a manifest for another version", { manifestVersion: "1.0.1" }, "integrity"],
  ])("rejects %s", async (_n, opts, kind) => {
    f = await makeEngineFixture();
    const e = await err(installSelf(f.deps, await selfSource("1.0.0", opts)));
    expect(e.kind).toBe(kind as never);
    expect(await readLink(f.layout)).toEqual({ kind: "missing" });
  });

  test("a missing manifest file is a usage error", async () => {
    f = await makeEngineFixture();
    const src = { ...(await selfSource("1.0.0")), manifestPath: join(f.root, "nope.json") };
    expect((await err(installSelf(f.deps, src))).kind).toBe("usage");
  });
});

describe("updateChannel", () => {
  test("up to date, skipped, updated, never a downgrade", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await f.release("0.9.0");
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "stable", "0.9.0\n");
    expect((await updateChannel(f.deps, "stable", { wait: true }))!.value).toEqual({ kind: "up-to-date", current: "1.0.0", available: "0.9.0" });
    f.srv.put("channels", "latest", "1.1.0\n");
    await writeState(f.layout, { ...(await f.state()), skip: { "1.1.0": "rolled-back" } });
    expect((await updateChannel(f.deps, "latest", { wait: true }))!.value).toEqual({ kind: "skipped", version: "1.1.0", reason: "rolled-back" });
    await writeState(f.layout, { ...(await f.state()), skip: {} });
    expect((await updateChannel(f.deps, "latest", { wait: true }))!.value.kind).toBe("updated");
  });
});
