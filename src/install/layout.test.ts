// src/install/layout.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { InstallError } from "./errors";
import { checkSafeDir, currentUser, ensureLayout, installLockPath, manifestDir, nativeVersionOf, resolveLayout, versionLockPath, versionPath } from "./layout";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

describe("resolveLayout", () => {
  test("defaults under HOME", () => {
    const l = resolveLayout({ HOME: "/h" });
    expect(l).toEqual({
      data: "/h/.local/share/tropos",
      versions: "/h/.local/share/tropos/versions",
      manifests: "/h/.local/share/tropos/manifests",
      staging: "/h/.local/share/tropos/staging",
      state: "/h/.local/state/tropos",
      stateFile: "/h/.local/state/tropos/install.json",
      locks: "/h/.local/state/tropos/locks",
      log: "/h/.local/state/tropos/update.log",
      binDir: "/h/.local/bin",
      binLink: "/h/.local/bin/tcode",
      aliasLinks: ["/h/.local/bin/tropos"],
    });
  });

  test("honours absolute XDG variables only", () => {
    expect(resolveLayout({ HOME: "/h", XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s" }).versions).toBe("/d/tropos/versions");
    expect(resolveLayout({ HOME: "/h", XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s" }).stateFile).toBe("/s/tropos/install.json");
    expect(resolveLayout({ HOME: "/h", XDG_DATA_HOME: "rel/d" }).data).toBe("/h/.local/share/tropos");
  });

  test("version paths refuse anything that is not a version (path traversal)", () => {
    const l = resolveLayout({ HOME: "/h" });
    expect(versionPath(l, "1.2.3")).toBe("/h/.local/share/tropos/versions/1.2.3");
    expect(manifestDir(l, "1.2.3")).toBe("/h/.local/share/tropos/manifests/1.2.3");
    expect(versionLockPath(l, "1.2.3")).toBe("/h/.local/state/tropos/locks/1.2.3.lock");
    expect(installLockPath(l)).toBe("/h/.local/state/tropos/locks/install.lock");
    for (const bad of ["../x", "1.0.0/../../", "1.2", ""]) expect(() => versionPath(l, bad)).toThrow(InstallError);
  });

  test("ensureLayout creates private directories and works with spaces in HOME", async () => {
    const l = resolveLayout({ HOME: join(dir, "Jane Doe") });
    await ensureLayout(l);
    for (const d of [l.data, l.versions, l.manifests, l.staging, l.state, l.locks]) expect((await stat(d)).mode & 0o777).toBe(0o700);
    expect((await stat(l.binDir)).isDirectory()).toBe(true);
  });

  test("ensureLayout rejects a pre-existing world-writable directory", async () => {
    const l = resolveLayout({ HOME: dir });
    await ensureLayout(l);
    await chmod(l.staging, 0o777);
    const err = await ensureLayout(l).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).kind).toBe("local");
  });

  test("ensureLayout rejects a pre-existing symlink in place of a managed directory", async () => {
    const l = resolveLayout({ HOME: dir });
    await mkdir(l.data, { recursive: true });
    await mkdir(join(dir, "elsewhere"));
    await symlink(join(dir, "elsewhere"), l.versions);
    await expect(ensureLayout(l)).rejects.toThrow("is a symbolic link");
  });

  test("ensureLayout accepts a pre-existing 0755 versions directory (old local-build installs)", async () => {
    const l = resolveLayout({ HOME: dir });
    await mkdir(l.versions, { recursive: true });
    await chmod(l.versions, 0o755);
    await ensureLayout(l);
    expect((await stat(l.versions)).isDirectory()).toBe(true);
  });
});

describe("checkSafeDir", () => {
  const user = currentUser();

  test("accepts a private directory", async () => {
    await chmod(dir, 0o700);
    await checkSafeDir(dir, user);
  });

  test("accepts group-writable dir owned by the user's primary group (Ubuntu umask 002, amendment A1)", async () => {
    await chmod(dir, 0o775);
    const st = await stat(dir);
    await checkSafeDir(dir, { uid: user.uid, gid: st.gid, user: "alice", group: "alice" });
  });

  test("refuses group-writable when the primary group is shared (macOS staff)", async () => {
    await chmod(dir, 0o775);
    const st = await stat(dir);
    await expect(checkSafeDir(dir, { uid: user.uid, gid: st.gid, user: "alice", group: "staff" })).rejects.toThrow("is writable by group");
  });

  test("refuses group-writable when the user or group name is unknown (fail closed)", async () => {
    await chmod(dir, 0o775);
    const st = await stat(dir);
    await expect(checkSafeDir(dir, { uid: user.uid, gid: st.gid, user: "", group: "" })).rejects.toThrow("is writable by group");
  });

  test("refuses group-writable for another group", async () => {
    await chmod(dir, 0o775);
    const st = await stat(dir);
    await expect(checkSafeDir(dir, { uid: user.uid, gid: st.gid + 1, user: "alice", group: "alice" })).rejects.toThrow("is writable by group");
  });

  test("currentUser reports the login and primary group names", () => {
    const u = currentUser();
    expect(u.user).toBe(Bun.spawnSync(["id", "-un"]).stdout.toString().trim());
    expect(u.group).toBe(Bun.spawnSync(["id", "-gn"]).stdout.toString().trim());
    expect(u.user).not.toBe("");
  });

  test("refuses world-writable", async () => {
    await chmod(dir, 0o777);
    await expect(checkSafeDir(dir, user)).rejects.toThrow("is writable by every user");
  });

  test("refuses another owner", async () => {
    await expect(checkSafeDir(dir, { ...user, uid: user.uid + 1 })).rejects.toThrow("is owned by another user");
  });

  test("refuses a symlink and a file", async () => {
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    await writeFile(join(dir, "file"), "");
    await expect(checkSafeDir(join(dir, "link"), user)).rejects.toThrow("is a symbolic link");
    await expect(checkSafeDir(join(dir, "file"), user)).rejects.toThrow("is not a directory");
  });
});

describe("nativeVersionOf", () => {
  test("is the version only for a binary directly inside versions/", async () => {
    const l = resolveLayout({ HOME: dir });
    await ensureLayout(l);
    await writeFile(join(l.versions, "1.2.3"), "");
    expect(nativeVersionOf(l, join(l.versions, "1.2.3"))).toBe("1.2.3");
    expect(nativeVersionOf(l, "/usr/local/bin/bun")).toBeNull();
    expect(nativeVersionOf(l, join(l.versions, "nested", "1.2.3"))).toBeNull();
    expect(nativeVersionOf(l, join(l.versions, "not-a-version"))).toBeNull();
    await symlink(join(l.versions, "1.2.3"), l.binLink);
    expect(nativeVersionOf(l, l.binLink)).toBe("1.2.3");
  });
});
