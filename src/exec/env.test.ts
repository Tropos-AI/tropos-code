// src/exec/env.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatEnv } from "./env";

const notGitConfig = (keys: string[]) => keys.filter((k) => !k.startsWith("GIT_CONFIG_"));

test("only the allowlist passes, LC_* included", () => {
  expect(notGitConfig(Object.keys(chatEnv({ PATH: "/usr/bin", HOME: "/h", LC_ALL: "C", GITHUB_TOKEN: "x", NODE_OPTIONS: "--require x" }, { project: "/w/app" }))).sort()).toEqual(["HOME", "LC_ALL", "PATH"]);
  const all = { PATH: "/usr/bin", HOME: "/h", USER: "u", SHELL: "/bin/zsh", LANG: "en", TERM: "xterm", TMPDIR: "/t", LC_CTYPE: "UTF-8", AWS_SECRET_ACCESS_KEY: "s", SSH_AUTH_SOCK: "/s", LD_PRELOAD: "/x.so", DYLD_INSERT_LIBRARIES: "/x.dylib", BASH_ENV: "/x", GIT_DIR: "/x" };
  expect(notGitConfig(Object.keys(chatEnv(all, { project: "/w/app" }))).sort()).toEqual(["HOME", "LANG", "LC_CTYPE", "PATH", "SHELL", "TERM", "TMPDIR", "USER"]);
});

test("PATH loses '.', empty, relative and project entries", () => {
  expect(chatEnv({ PATH: ".::bin:/w/app/node_modules/.bin:/usr/bin" }, { project: "/w/app" }).PATH).toBe("/usr/bin");
  expect(chatEnv({ PATH: "." }, { project: "/w/app" }).PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  expect(chatEnv({}, { project: "/w/app" }).PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  // A sibling that only shares the project's name prefix stays.
  expect(chatEnv({ PATH: "/w/app2/bin:/w/app" }, { project: "/w/app" }).PATH).toBe("/w/app2/bin");
});

test("a PATH entry that really lives in the project through a link is dropped too", () => {
  const fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-env-")));
  try {
    mkdirSync(join(fx, "app", "bin"), { recursive: true });
    symlinkSync(join(fx, "app", "bin"), join(fx, "link"));
    expect(chatEnv({ PATH: `${join(fx, "link")}:/usr/bin` }, { project: join(fx, "app") }).PATH).toBe("/usr/bin");
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
});

test("git's config-driven programs are switched off and its pager variables never pass", () => {
  const env = chatEnv({ PATH: "/usr/bin", GIT_EXTERNAL_DIFF: "/x", GIT_PAGER: "/x", PAGER: "/x", GIT_CONFIG_COUNT: "9", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "/x" }, { project: "/w/app" });
  expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
  expect(env.GIT_PAGER).toBeUndefined();
  expect(env.PAGER).toBeUndefined();
  expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  const count = Number(env.GIT_CONFIG_COUNT);
  const overrides = Object.fromEntries(Array.from({ length: count }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  expect(overrides).toEqual({
    "core.fsmonitor": "false",
    "core.pager": "cat",
    "core.hooksPath": "/dev/null",
    "log.showSignature": "false",
    "gpg.program": "/usr/bin/false",
  });
  // diff.external is NOT overridden: git has no "off" value and an empty one breaks every patch-printing git diff.
  expect(Object.keys(overrides)).not.toContain("diff.external");
  expect(env[`GIT_CONFIG_KEY_${count}`]).toBeUndefined();
});

test("package caches are redirected into the per-sandbox cache, never the owner's host caches", () => {
  const withHome = chatEnv({ PATH: "/usr/bin" }, { project: "/w/app", troposHome: "/h/.tropos" });
  expect(withHome.npm_config_cache).toBe("/h/.tropos/sandbox-cache/npm");
  expect(withHome.npm_config_store_dir).toBe("/h/.tropos/sandbox-cache/pnpm");
  expect(withHome.BUN_INSTALL_CACHE_DIR).toBe("/h/.tropos/sandbox-cache/bun");
  expect(withHome.PIP_CACHE_DIR).toBe("/h/.tropos/sandbox-cache/pip");
  expect(withHome.YARN_CACHE_FOLDER).toBe("/h/.tropos/sandbox-cache/yarn");
  expect(withHome.GOMODCACHE).toBe("/h/.tropos/sandbox-cache/go-mod");
  expect(withHome.GOCACHE).toBe("/h/.tropos/sandbox-cache/go-build");
  // Toolchains stay reachable: CARGO_HOME is left alone so ~/.cargo/bin and rustup still resolve.
  expect(withHome.CARGO_HOME).toBeUndefined();
  // Without a home (e.g. a diagnostic call), no cache vars are set.
  expect(chatEnv({ PATH: "/usr/bin" }, { project: "/w/app" }).npm_config_cache).toBeUndefined();
});
