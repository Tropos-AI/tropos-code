// src/install/link.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { ensureLayout, resolveLayout, versionPath, type Layout } from "./layout";
import { linkResolvesTo, migrateLegacyLink, readLink, removeOurLink, switchLink, syncAliases } from "./link";

let dir: string;
let l: Layout;
beforeEach(async () => {
  dir = await makeTmpDir();
  l = resolveLayout({ HOME: join(dir, "with space") });
  await ensureLayout(l);
  await writeFile(versionPath(l, "1.0.0"), "a");
  await writeFile(versionPath(l, "1.1.0"), "b");
});
afterEach(() => removeDir(dir));

describe("the tcode symlink", () => {
  test("missing, then ours, switched atomically with no temp leftovers", async () => {
    expect(await readLink(l)).toEqual({ kind: "missing" });
    await switchLink(l, "1.0.0");
    expect(await readLink(l)).toEqual({ kind: "ours", version: "1.0.0" });
    await switchLink(l, "1.1.0");
    expect(await readlink(l.binLink)).toBe(versionPath(l, "1.1.0"));
    expect(await linkResolvesTo(l, "1.1.0")).toBe(true);
    expect((await readdir(l.binDir)).sort()).toEqual(["tcode", "tropos"]);
    // The old name is an alias of the command, so it follows every switch.
    expect(await readlink(join(l.binDir, "tropos"))).toBe("tcode");
  });

  test("an unmanaged symlink into versions/ from the old local-build installer counts as ours", async () => {
    await writeFile(versionPath(l, "0.1.0"), "local build");
    await symlink(versionPath(l, "0.1.0"), l.binLink);
    expect(await readLink(l)).toEqual({ kind: "ours", version: "0.1.0" });
  });

  test("dangling and foreign links", async () => {
    await symlink(versionPath(l, "2.0.0"), l.binLink);
    expect(await readLink(l)).toEqual({ kind: "dangling-ours", version: "2.0.0" });
    expect(await removeOurLink(l)).toBe(true);
    await symlink("/usr/local/bin/something", l.binLink);
    expect(await readLink(l)).toEqual({ kind: "foreign", target: "/usr/local/bin/something" });
    expect(await removeOurLink(l)).toBe(false);
  });

  test("a regular file is foreign", async () => {
    await writeFile(l.binLink, "#!/bin/sh\n");
    expect(await readLink(l)).toEqual({ kind: "foreign", target: null });
  });
});

describe("the tropos alias (the command before 0.3.0)", () => {
  const alias = () => join(l.binDir, "tropos");

  test("an install from before 0.3.0 gets tcode on first run, and tropos becomes its alias", async () => {
    await symlink(versionPath(l, "1.0.0"), alias());
    expect(await migrateLegacyLink(l)).toBe("1.0.0");
    expect(await readlink(l.binLink)).toBe(versionPath(l, "1.0.0"));
    expect(await readlink(alias())).toBe("tcode");
    // Nothing to do once tcode exists.
    expect(await migrateLegacyLink(l)).toBeNull();
  });

  test("migration skips a missing, foreign or dangling old link", async () => {
    expect(await migrateLegacyLink(l)).toBeNull();
    await symlink("/usr/local/bin/something", alias());
    expect(await migrateLegacyLink(l)).toBeNull();
    expect(await readlink(alias())).toBe("/usr/local/bin/something");
  });

  test("a dangling old link into versions/ is not migrated", async () => {
    await symlink(versionPath(l, "9.9.9"), alias());
    expect(await migrateLegacyLink(l)).toBeNull();
  });

  test("a user's own tropos file or link is never touched", async () => {
    await writeFile(alias(), "#!/bin/sh\necho mine\n");
    await switchLink(l, "1.0.0");
    expect(await Bun.file(alias()).text()).toContain("mine");
    await removeOurLink(l);
    expect(await Bun.file(alias()).text()).toContain("mine");
  });

  test("removing the command removes our alias too; syncing is idempotent", async () => {
    await switchLink(l, "1.0.0");
    await syncAliases(l);
    expect(await readlink(alias())).toBe("tcode");
    expect(await removeOurLink(l)).toBe(true);
    expect(await readdir(l.binDir)).toEqual([]);
  });
});
