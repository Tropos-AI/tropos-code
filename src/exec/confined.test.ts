// src/exec/confined.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfinedBackend, confinedBackend, confinementAvailable, detectConfinement, TRUSTED_PATH, unconfinedBackend } from "./confined";
import { ConfinementError } from "./confinement-paths";
import { COMMONDIR_TAMPERED, GIT_METADATA_TAMPERED } from "./git-integrity";

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
};
const collect = (child: ChildProcess) =>
  new Promise<{ out: string; err: string; code: number | null }>((resolve) => {
    let out = "";
    let err = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.once("close", (code) => resolve({ out, err, code }));
  });

/** A fake user home and project under a fresh temp dir; nothing here touches the real home. */
const fixture = () => {
  const fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-confined-")));
  const userHome = join(fx, "home");
  const project = join(fx, "proj");
  const outside = join(fx, "outside");
  for (const d of [join(userHome, ".ssh"), join(userHome, ".tropos", "workspace"), join(project, ".git", "hooks"), join(project, ".git", "modules", "lib", "hooks"), join(project, ".husky"), join(fx, "tmp"), outside]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(userHome, ".ssh", "id"), "key");
  writeFileSync(join(userHome, ".tropos", "secret"), "token");
  writeFileSync(join(userHome, ".tropos", "workspace", "f"), "w");
  writeFileSync(join(project, ".git", "config"), "");
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(project, ".git", "modules", "lib", "HEAD"), "ref: refs/heads/main\n");
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: userHome, TMPDIR: join(fx, "tmp"), SECRET: "s3cret", LANG: "C" };
  return { fx, userHome, home: join(userHome, ".tropos"), project, outside, env };
};

const available = await confinementAvailable();

test("detectConfinement asks the platform's tool and treats a missing one as none", async () => {
  const asked: string[][] = [];
  const ok = async (bin: string, args: string[]) => {
    asked.push([bin, ...args]);
    return { code: 0 };
  };
  expect(await detectConfinement(ok, "darwin")).toBe("sandbox-exec");
  expect(await detectConfinement(ok, "linux")).toBe("bwrap");
  expect(asked).toEqual([
    ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"],
    ["bwrap", "--ro-bind", "/", "/", "/bin/true"],
  ]);
  expect(await detectConfinement(async () => ({ code: null }), "linux")).toBeNull();
  expect(await detectConfinement(async () => ({ code: 1 }), "darwin")).toBeNull();
  expect(await detectConfinement(async () => Promise.reject(new Error("ENOENT")), "darwin")).toBeNull();
  expect(await detectConfinement(async () => ({ code: 0 }), "win32")).toBeNull();
});

test("confinementAvailable is cached for the process", async () => {
  expect(confinementAvailable()).toBe(confinementAvailable());
  expect(await confinementAvailable()).toBe(available);
});

test("a platform without confinement is refused", () => {
  const { fx, ...f } = fixture();
  try {
    expect(() => new ConfinedBackend({ ...f, platform: "win32" })).toThrow(ConfinementError);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
});

describe.skipIf(available === null)("with real confinement", () => {
  let f: ReturnType<typeof fixture>;
  let backend: ReturnType<typeof confinedBackend>;
  const run = (script: string, cwd = f.project) => collect(backend.spawn({ shell: "/bin/sh", script, cwd, env: { PASSED: "no" } }));
  const code = async (script: string) => (await run(script)).code;
  beforeAll(() => {
    f = fixture();
    backend = confinedBackend({ project: f.project, home: f.home, userHome: f.userHome, env: f.env });
  });
  afterAll(async () => {
    await backend.close();
    rmSync(f.fx, { recursive: true, force: true });
  });

  test("is a confined backend", () => {
    expect(backend.kind).toBe("confined");
  });

  test("project, temp and cache writes work; writes elsewhere fail", async () => {
    expect(await code("echo a > a.txt && mkdir -p src && echo b > src/b.txt")).toBe(0);
    expect(readFileSync(join(f.project, "src", "b.txt"), "utf8")).toBe("b\n");
    expect(await code('echo a > "$TMPDIR/t.txt"')).toBe(0);
    expect(await code('echo a > "$npm_config_cache/x" && cat "$npm_config_cache/x"')).toBe(0);
    expect(await code(`echo a > '${join(f.outside, "x")}'`)).not.toBe(0);
    expect(await code(`echo a > '${join(f.userHome, "x")}'`)).not.toBe(0);
    expect(await code(`echo a > '${join(f.home, "gateway.json")}'`)).not.toBe(0);
    expect(existsSync(join(f.outside, "x"))).toBe(false);
    expect(existsSync(join(f.userHome, "x"))).toBe(false);
    expect(existsSync(join(f.home, "gateway.json"))).toBe(false);
  });

  test(".git/hooks, .git/config, .husky, a submodule's hooks and renaming .git or the project all fail", async () => {
    expect(await code("echo a > .git/hooks/pre-commit")).not.toBe(0);
    expect(await code("echo a >> .git/config")).not.toBe(0);
    expect(await code("echo a > .husky/pre-commit")).not.toBe(0);
    expect(await code("echo a > .git/modules/lib/hooks/post-checkout")).not.toBe(0);
    expect(await code("mv .git g2")).not.toBe(0);
    expect(await code(`mv '${f.project}' '${f.project}2'`)).not.toBe(0);
    expect(existsSync(join(f.project, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(f.project, ".husky", "pre-commit"))).toBe(false);
    expect(existsSync(join(f.project, ".git", "modules", "lib", "hooks", "post-checkout"))).toBe(false);
    expect(readFileSync(join(f.project, ".git", "config"), "utf8")).toBe("");
    expect(existsSync(join(f.project, ".git", "HEAD"))).toBe(true);
    expect(existsSync(f.project)).toBe(true);
    // An ordinary file in .git is not protected: the chat's own git keeps working.
    expect(await code("echo a > .git/HEAD.new && rm .git/HEAD.new")).toBe(0);
  });

  test("reads of the fake ~/.ssh and ~/.tropos fail, ~/.tropos/workspace reads work", async () => {
    const ssh = await run(`cat '${join(f.userHome, ".ssh", "id")}'`);
    expect(ssh.code).not.toBe(0);
    expect(ssh.out).not.toContain("key");
    const secret = await run(`cat '${join(f.home, "secret")}'`);
    expect(secret.code).not.toBe(0);
    expect(secret.out).not.toContain("token");
    const workspace = await run(`cat '${join(f.home, "workspace", "f")}'`);
    expect(workspace).toMatchObject({ code: 0, out: "w" });
  });

  test("network is allowed (a local Bun.serve on 127.0.0.1 answers curl)", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("pong") });
    try {
      const r = await run(`curl -s --max-time 5 http://127.0.0.1:${server.port}/`);
      expect(r).toMatchObject({ code: 0, out: "pong" });
    } finally {
      server.stop(true);
    }
  });

  test("only the allowlisted environment reaches the command", async () => {
    const r = await run('echo "${SECRET-unset}|${PASSED-unset}|$PATH|$HOME|$npm_config_cache"');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`unset|unset|/usr/bin:/bin|${f.userHome}|${join(realpathSync(f.home), "sandbox-cache", "npm")}`);
  });

  test("the cwd marker is the same file inside and on the host, under the confined temp dir", async () => {
    const marker = backend.cwdMarker("abc");
    expect(marker.inside).toBe(marker.host);
    expect(marker.host.startsWith(`${realpathSync(join(f.fx, "tmp"))}/`)).toBe(true);
    expect(marker.host).toContain("abc");
    expect(await code(`cd src && pwd -P > '${marker.inside}'`)).toBe(0);
    expect(readFileSync(marker.host, "utf8").trim()).toBe(join(f.project, "src"));
  });

  test("signal() stops the whole group and alive() follows it", async () => {
    const child = backend.spawn({ shell: "/bin/sh", script: "sleep 30 & sleep 30; wait", cwd: f.project, env: {} });
    child.stdout!.resume();
    child.stderr!.resume();
    expect(backend.alive(child)).toBe(true);
    const closed = new Promise((r) => child.once("close", r));
    backend.signal(child, "SIGTERM");
    await closed;
    await until(() => !backend.alive(child));
    expect(() => backend.signal(child, "SIGKILL")).not.toThrow();
  });
});

test("unconfinedBackend runs on the host with the allowlisted environment", async () => {
  const { fx, project, outside, env } = fixture();
  try {
    const backend = unconfinedBackend({ project, env });
    expect(backend.kind).toBe("local");
    const r = await collect(backend.spawn({ shell: "/bin/sh", script: `echo "\${SECRET-unset}|\${PASSED-unset}|$PATH"; echo a > '${join(outside, "x")}'`, cwd: project, env: { PASSED: "no" } }));
    expect(r).toMatchObject({ code: 0, out: "unset|unset|/usr/bin:/bin\n" });
    expect(existsSync(join(outside, "x"))).toBe(true); // not confined
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
});

// bwrap itself only exists on Linux; a stand-in that applies --setenv and --chdir and runs the command after `--`
// checks the wrapper, the environment split and the host-side git checks on any machine. It records the environment
// the wrapper gave it. The real confinement of bwrapArgs is covered by bwrap-args.test.ts.
describe("the bwrap backend (fake bwrap)", () => {
  const FAKE_BWRAP = [
    "#!/bin/sh",
    'env > "$(dirname "$0")/wrapper-env"',
    'dir=""',
    'while [ "$#" -gt 0 ]; do case "$1" in --chdir) dir="$2"; shift 2;; --setenv) export "$2=$3"; shift 3;; --) shift; break;; *) shift;; esac; done',
    'cd "$dir" || exit 1',
    'exec "$@"',
    "",
  ].join("\n");
  let f: ReturnType<typeof fixture>;
  let backend: ConfinedBackend;
  let bin: string;
  beforeAll(() => {
    f = fixture();
    bin = join(f.fx, "bwrap");
    writeFileSync(bin, FAKE_BWRAP, { mode: 0o755 });
    writeFileSync(join(f.project, ".git", "modules", "lib", "hooks", "pre-commit"), "owner's hook");
    writeFileSync(join(f.project, ".git", "modules", "lib", "config"), "[core]");
    backend = new ConfinedBackend({ project: f.project, home: f.home, userHome: f.userHome, env: f.env, platform: "linux", bwrapBin: bin });
  });
  afterAll(() => rmSync(f.fx, { recursive: true, force: true }));
  const commondir = () => join(f.project, ".git", "commondir");
  const sh = (script: string, cwd = f.project) => collect(backend.spawn({ shell: "/bin/sh", script, cwd, env: { PASSED: "no" } }));

  test("the wrapper and bwrap get only the trusted PATH; the command gets the allowlisted environment", async () => {
    const r = await sh('echo "$PATH|$npm_config_cache|${SECRET-unset}|${PASSED-unset}"');
    expect(r).toMatchObject({ code: 0, out: `/usr/bin:/bin|${join(realpathSync(f.home), "sandbox-cache", "npm")}|unset|unset\n` });
    const wrapperEnv = readFileSync(join(f.fx, "wrapper-env"), "utf8").split("\n");
    expect(wrapperEnv).toContain(`PATH=${TRUSTED_PATH}`);
    for (const key of ["HOME=", "TMPDIR=", "npm_config_cache=", "GIT_CONFIG_COUNT=", "SECRET="]) expect(wrapperEnv.some((l) => l.startsWith(key))).toBe(false);
  });

  test("a bwrap a confined command could write is refused", () => {
    const opts = { project: f.project, home: f.home, userHome: f.userHome, env: f.env, platform: "linux" as const };
    for (const planted of [join(f.fx, "tmp", "bwrap"), join(f.project, "bwrap")]) {
      writeFileSync(planted, FAKE_BWRAP, { mode: 0o755 });
      expect(() => new ConfinedBackend({ ...opts, bwrapBin: planted })).toThrow(ConfinementError);
      rmSync(planted);
    }
    // A link from a trusted-looking place into a writable dir is judged by where it really points.
    writeFileSync(join(f.fx, "tmp", "real-bwrap"), FAKE_BWRAP, { mode: 0o755 });
    symlinkSync(join(f.fx, "tmp", "real-bwrap"), join(f.fx, "linked-bwrap"));
    expect(() => new ConfinedBackend({ ...opts, bwrapBin: join(f.fx, "linked-bwrap") })).toThrow(ConfinementError);
    expect(() => new ConfinedBackend({ ...opts, bwrapBin: join(f.fx, "missing-bwrap") })).toThrow(ConfinementError);
  });

  const trustedBwrap = TRUSTED_PATH.split(":").some((d) => existsSync(join(d, "bwrap")));
  test.skipIf(trustedBwrap)("bwrap is looked up only on the trusted PATH, never the owner's", () => {
    const env = { ...f.env, PATH: `${f.fx}:${f.env.PATH}` }; // the fake bwrap sits on this PATH
    expect(() => new ConfinedBackend({ project: f.project, home: f.home, userHome: f.userHome, env, platform: "linux" })).toThrow(ConfinementError);
  });

  test("a command that plants .git/commondir fails with the host's message and the file is removed", async () => {
    const r = await sh("pwd -P; echo /elsewhere > commondir; echo done", join(f.project, ".git"));
    expect(r.out).toBe(`${join(f.project, ".git")}\ndone\n`);
    expect(r.err).toContain(COMMONDIR_TAMPERED);
    expect(r.code).toBe(1);
    expect(existsSync(commondir())).toBe(false);
  });

  test("a submodule's planted commondir is caught too, and a clean command keeps its exit code", async () => {
    const r = await sh("ln -s /nowhere .git/modules/lib/commondir");
    expect(r.err).toContain(COMMONDIR_TAMPERED);
    expect(r.code).toBe(1);
    expect(() => lstatSync(join(f.project, ".git", "modules", "lib", "commondir"))).toThrow();
    expect(await sh("exit 3")).toEqual({ out: "", err: "", code: 3 });
  });

  test("a new submodule git dir with hooks and config fails the command and loses them; existing ones are untouched", async () => {
    const fresh = join(f.project, ".git", "modules", "evil");
    const r = await sh("mkdir -p .git/modules/evil/hooks && echo ref > .git/modules/evil/HEAD && echo x > .git/modules/evil/hooks/post-checkout && echo x > .git/modules/evil/config");
    expect(r.code).toBe(1);
    expect(r.err).toContain(GIT_METADATA_TAMPERED);
    expect(existsSync(join(fresh, "hooks"))).toBe(false);
    expect(existsSync(join(fresh, "config"))).toBe(false);
    expect(existsSync(join(fresh, "HEAD"))).toBe(true);
    expect(readFileSync(join(f.project, ".git", "modules", "lib", "hooks", "pre-commit"), "utf8")).toBe("owner's hook");
    expect(readFileSync(join(f.project, ".git", "modules", "lib", "config"), "utf8")).toBe("[core]");
    rmSync(fresh, { recursive: true });
  });

  test("a killed command that planted git metadata is still caught on the host, even if it printed the message itself", async () => {
    const script = `echo ${JSON.stringify(COMMONDIR_TAMPERED)} >&2; echo x > .git/commondir; mkdir -p .git/worktrees/w/hooks && echo r > .git/worktrees/w/HEAD && echo x > .git/worktrees/w/hooks/x; sleep 30`;
    const child = backend.spawn({ shell: "/bin/sh", script, cwd: f.project, env: {} });
    const result = collect(child);
    await until(() => existsSync(join(f.project, ".git", "worktrees", "w", "hooks", "x")));
    backend.signal(child, "SIGKILL"); // the wrapper dies before it can report to the host
    const r = await result;
    expect(r.code).not.toBe(0);
    expect(r.err.split(COMMONDIR_TAMPERED).length - 1).toBe(2); // the command's fake line, then the host's real one
    expect(r.err).toContain(GIT_METADATA_TAMPERED);
    expect(existsSync(commondir())).toBe(false);
    expect(existsSync(join(f.project, ".git", "worktrees", "w", "hooks"))).toBe(false);
    rmSync(join(f.project, ".git", "worktrees"), { recursive: true });
  });

  test("a commondir that existed before the command is left alone", async () => {
    writeFileSync(commondir(), "../..\n");
    try {
      expect(await sh("true")).toEqual({ out: "", err: "", code: 0 });
      expect(readFileSync(commondir(), "utf8")).toBe("../..\n");
    } finally {
      rmSync(commondir(), { force: true });
    }
  });
});
