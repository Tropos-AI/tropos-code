import { afterEach, expect, test } from "bun:test";
import { mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveLayout, versionPath } from "../../install/layout";
import { emptyState, writeState } from "../../install/state";
import { byId, makeFixture, runOne, type Fixture } from "../testing";
import { UPDATE_LOG_WARN_BYTES, installCheck } from "./install";

let fx: Fixture;
afterEach(() => fx?.close());

async function layoutOf() {
  const l = resolveLayout(fx.env, fx.userHome);
  for (const d of [l.versions, l.state, l.binDir, l.locks]) await mkdir(d, { recursive: true });
  return l;
}
const withPath = (l: { binDir: string }) => ({ env: { ...fx.env, PATH: l.binDir } });

test("a source checkout (no link, no versions) is informational, not a problem", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, installCheck);
  expect(byId(r, "install.link")!.level).toBe("info");
  expect(r.summary.error).toBe(0);
});

test("a healthy link, on PATH", async () => {
  fx = await makeFixture();
  const l = await layoutOf();
  await mkdir(versionPath(l, "1.2.0"));
  await symlink(versionPath(l, "1.2.0"), l.binLink);
  const r = await runOne(fx, installCheck, withPath(l));
  expect(byId(r, "install.link")).toMatchObject({ level: "ok" });
  expect(byId(r, "install.path")!.level).toBe("ok");
});

test("PATH without ~/.local/bin warns with the line to add", async () => {
  fx = await makeFixture();
  await layoutOf();
  const r = await runOne(fx, installCheck);
  expect(byId(r, "install.path")).toMatchObject({ level: "warn", detail: expect.stringContaining('export PATH="$HOME/.local/bin:$PATH"') });
});

test("a dangling link is an error; the fix points it at the recorded version", async () => {
  fx = await makeFixture();
  const l = await layoutOf();
  await mkdir(versionPath(l, "0.9.0"));
  await writeState(l, { ...emptyState(), current: "0.9.0" });
  await symlink(versionPath(l, "1.0.0"), l.binLink);

  const plain = await runOne(fx, installCheck, withPath(l));
  expect(byId(plain, "install.link")).toMatchObject({ level: "error", fixable: true });
  expect(await readlink(l.binLink)).toBe(versionPath(l, "1.0.0"));

  const fixed = await runOne(fx, installCheck, { ...withPath(l), fix: true });
  expect(byId(fixed, "install.link")!.fixed).toBe(true);
  expect(await readlink(l.binLink)).toBe(versionPath(l, "0.9.0"));
});

test("a dangling link with nothing to go back to cannot be fixed", async () => {
  fx = await makeFixture();
  const l = await layoutOf();
  await symlink(versionPath(l, "1.0.0"), l.binLink);
  const f = byId(await runOne(fx, installCheck, withPath(l)), "install.link")!;
  expect(f.level).toBe("error");
  expect(f.fixable).toBeUndefined();
  expect(f.detail).toContain("install.sh");
});

test("a link that disagrees with the install state is a warning with a fix", async () => {
  fx = await makeFixture();
  const l = await layoutOf();
  await mkdir(versionPath(l, "1.0.0"));
  await mkdir(versionPath(l, "1.1.0"));
  await writeState(l, { ...emptyState(), current: "1.1.0" });
  await symlink(versionPath(l, "1.0.0"), l.binLink);
  const r = await runOne(fx, installCheck, { ...withPath(l), fix: true });
  expect(byId(r, "install.version")).toMatchObject({ fixed: true });
  expect(await readlink(l.binLink)).toBe(versionPath(l, "1.1.0"));
});

test("a foreign file at ~/.local/bin/tcode is left alone", async () => {
  fx = await makeFixture();
  const l = await layoutOf();
  await writeFile(l.binLink, "#!/bin/sh\n");
  const r = await runOne(fx, installCheck, { ...withPath(l), fix: true });
  expect(byId(r, "install.link")!.level).toBe("info");
});

test("another tcode on PATH is reported as a duplicate", async () => {
  fx = await makeFixture();
  const l = await layoutOf();
  await mkdir(versionPath(l, "1.2.0"));
  await symlink(versionPath(l, "1.2.0"), l.binLink);
  const other = join(fx.root, "npm-bin");
  await mkdir(other);
  await writeFile(join(other, "tcode"), "");
  const r = await runOne(fx, installCheck, { env: { ...fx.env, PATH: `${other}:${l.binDir}` } });
  expect(byId(r, "install.duplicates")).toMatchObject({ level: "warn", message: expect.stringContaining(join(other, "tcode")) });
});

test("a huge update.log warns, and the fix rotates it", async () => {
  fx = await makeFixture();
  const l = await layoutOf();
  await writeFile(l.log, Buffer.alloc(UPDATE_LOG_WARN_BYTES + 1));
  const r = await runOne(fx, installCheck, { ...withPath(l), fix: true });
  expect(byId(r, "install.log")!.fixed).toBe(true);
  expect(await Bun.file(`${l.log}.1`).exists()).toBe(true);
  expect(await Bun.file(l.log).exists()).toBe(false);
});

test("a tcode on PATH is not a duplicate when there is no managed link, and PATH repeats are ignored", async () => {
  fx = await makeFixture();
  const l = await layoutOf();
  const other = join(fx.root, "npm-bin");
  await mkdir(other);
  await writeFile(join(other, "tcode"), "");
  const none = await runOne(fx, installCheck, { env: { ...fx.env, PATH: `${other}:${other}` } });
  expect(byId(none, "install.duplicates")).toBeUndefined();
  await mkdir(versionPath(l, "1.2.0"));
  await symlink(versionPath(l, "1.2.0"), l.binLink);
  const dup = await runOne(fx, installCheck, { env: { ...fx.env, PATH: `${other}:${other}:${l.binDir}` } });
  expect(byId(dup, "install.duplicates")!.message.match(/npm-bin\/tcode/g)).toHaveLength(1);
});
