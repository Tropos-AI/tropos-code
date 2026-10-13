// src/install/link.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { ensureLayout, resolveLayout, versionPath, type Layout } from "./layout";
import { linkResolvesTo, readLink, removeOurLink, switchLink } from "./link";

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

describe("the tropos symlink", () => {
  test("missing, then ours, switched atomically with no temp leftovers", async () => {
    expect(await readLink(l)).toEqual({ kind: "missing" });
    await switchLink(l, "1.0.0");
    expect(await readLink(l)).toEqual({ kind: "ours", version: "1.0.0" });
    await switchLink(l, "1.1.0");
    expect(await readlink(l.binLink)).toBe(versionPath(l, "1.1.0"));
    expect(await linkResolvesTo(l, "1.1.0")).toBe(true);
    expect(await readdir(l.binDir)).toEqual(["tropos"]);
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
