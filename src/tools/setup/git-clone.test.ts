// src/tools/setup/git-clone.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { git } from "../../snapshots/test-repo";
import { CLONE_FLAGS, shallowClone } from "./git-clone";

let root: string;
let userHome: string;
let marker: string;
let env: NodeJS.ProcessEnv;

/** A bare repo holding `files` (and a symlink to a file outside), reachable as file://. */
async function bareRepo(files: Record<string, string>): Promise<string> {
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  git(work, "init", "-q");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(work, rel, ".."), { recursive: true });
    await writeFile(join(work, rel), text);
  }
  await symlink("/etc/hosts", join(work, "outside"));
  git(work, "add", "-A");
  git(work, "commit", "-qm", "init");
  const bare = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", work, bare);
  return `file://${bare}`;
}

// The user's own global git config names hooks (core.hooksPath and a template), as a dotfiles setup might: a post-checkout
// there would run on every clone.
beforeEach(async () => {
  root = await makeTmpDir();
  userHome = join(root, "home");
  marker = join(root, "hook-ran");
  const hooks = join(root, "hooks");
  const template = join(root, "template", "hooks");
  for (const dir of [userHome, hooks, template]) await mkdir(dir, { recursive: true });
  for (const dir of [hooks, template]) {
    await writeFile(join(dir, "post-checkout"), `#!/bin/sh\necho ran >> '${marker}'\n`);
    await chmod(join(dir, "post-checkout"), 0o755);
  }
  await writeFile(join(userHome, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n[init]\n\ttemplateDir = ${join(root, "template")}\n`);
  env = { HOME: userHome, PATH: process.env.PATH };
});
afterEach(() => removeDir(root));

test("the fixture's hooks do run on a plain clone, so the next test means something", async () => {
  const url = await bareRepo({ "a.txt": "one\n" });
  const r = Bun.spawnSync(["git", "clone", "-q", "--depth", "1", url, join(root, "plain")], { env });
  expect(r.exitCode).toBe(0);
  expect(existsSync(marker)).toBe(true);
});

test("a shallow clone runs no hook and turns a symlink into a plain file", async () => {
  const url = await bareRepo({ "a.txt": "one\n", "sub/b.txt": "two\n" });
  const dest = join(root, "copy");
  await shallowClone(url, dest, { env });
  expect(existsSync(marker)).toBe(false);
  expect(await readFile(join(dest, "sub", "b.txt"), "utf8")).toBe("two\n");
  expect(lstatSync(join(dest, "outside")).isSymbolicLink()).toBe(false);
  expect(await readFile(join(dest, "outside"), "utf8")).toBe("/etc/hosts");
});

test("only https and file URLs reach git: ext::, ssh, http and option-like URLs are refused before it runs", async () => {
  for (const url of ["ext::sh -c touch% /tmp/pwned", "ssh://git@example.com/x.git", "git@example.com:x.git", "http://example.com/x.git", "-uhelp", "--upload-pack=touch /tmp/x"]) {
    await expect(shallowClone(url, join(root, "x"), { env })).rejects.toThrow(/https/);
  }
  expect(existsSync(join(root, "x"))).toBe(false);
});

test("git never follows a redirect: the host the owner approved is the only one asked", () => {
  expect(CLONE_FLAGS.join(" ")).toContain("-c http.followRedirects=false");
});

test("an https host is looked up before git runs; one that resolves to a private address, or doesn't resolve, is refused", async () => {
  const looked: string[] = [];
  const resolve = async (host: string) => {
    looked.push(host);
    if (host === "git.internal-corp.example") return ["10.1.2.3"];
    if (host === "v6.example") return ["fe80::1"];
    throw new Error("ENOTFOUND");
  };
  await expect(shallowClone("https://git.internal-corp.example/x.git", join(root, "a"), { env, resolve })).rejects.toThrow(/local network/);
  await expect(shallowClone("https://v6.example/x.git", join(root, "b"), { env, resolve })).rejects.toThrow(/local network/);
  await expect(shallowClone("https://nowhere.example/x.git", join(root, "c"), { env, resolve })).rejects.toThrow(/couldn't find/);
  expect(looked).toEqual(["git.internal-corp.example", "v6.example", "nowhere.example"]);
  for (const d of ["a", "b", "c"]) expect(existsSync(join(root, d))).toBe(false);
  // A file:// repository the owner named is local by design: nothing is looked up.
  await shallowClone(await bareRepo({ "a.txt": "one\n" }), join(root, "d"), { env, resolve });
  expect(looked).toHaveLength(3);
});

/** A stand-in git that reports `version` and writes the arguments of a clone to a file (then fails, as offline). */
async function fakeGit(version: string): Promise<{ env: NodeJS.ProcessEnv; args: () => Promise<string[]> }> {
  const bin = join(root, `bin-${version}`);
  const out = join(bin, "args.txt");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "git"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\nprintf '%s\\n' "$@" > '${out}'\nexit 1\n`);
  await chmod(join(bin, "git"), 0o755);
  return { env: { HOME: userHome, PATH: `${bin}:${process.env.PATH}` }, args: async () => (await readFile(out, "utf8")).trim().split("\n") };
}

test("git is pinned to the addresses that were checked, so a second lookup can't send it elsewhere", async () => {
  const git = await fakeGit("2.54.0");
  const resolve = async () => ["93.184.216.34", "2606:4700::1111"];
  await expect(shallowClone("https://git.example/acme/kit.git", join(root, "a"), { env: git.env, resolve })).rejects.toThrow(/couldn't be cloned/);
  expect(await git.args()).toContain("http.curloptResolve=git.example:443:93.184.216.34,[2606:4700::1111]");
  await expect(shallowClone("https://git.example:8443/kit.git", join(root, "b"), { env: git.env, resolve })).rejects.toThrow(/couldn't be cloned/);
  expect(await git.args()).toContain("http.curloptResolve=git.example:8443:93.184.216.34,[2606:4700::1111]");
});

test("a git older than 2.37 (no http.curloptResolve) clones as before, unpinned; a file:// repository is never pinned", async () => {
  const old = await fakeGit("2.30.1");
  await expect(shallowClone("https://git.example/kit.git", join(root, "a"), { env: old.env, resolve: async () => ["93.184.216.34"] })).rejects.toThrow(/couldn't be cloned/);
  expect((await old.args()).join(" ")).not.toContain("curloptResolve");
  expect(await old.args()).toContain("https://git.example/kit.git");
  const now = await fakeGit("2.54.0");
  await expect(shallowClone("file:///srv/kit.git", join(root, "b"), { env: now.env, resolve: async () => ["93.184.216.34"] })).rejects.toThrow(/couldn't be cloned/);
  expect((await now.args()).join(" ")).not.toContain("curloptResolve");
});

test("a clone that fails says why and leaves nothing behind", async () => {
  const dest = join(root, "missing");
  await expect(shallowClone(`file://${join(root, "nope.git")}`, dest, { env })).rejects.toThrow(/couldn't be cloned/);
  expect(existsSync(dest)).toBe(false);
});
