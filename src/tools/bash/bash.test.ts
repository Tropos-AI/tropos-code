// src/tools/bash/bash.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecBackend } from "../../exec/backend";
import { localBackend } from "../../exec/local";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { toInputSchema } from "../schema";
import { bashTool, isSecretEnvName } from "./bash";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "sub"));
});

// The background-job test deliberately leaves `sleep 20` running (that is the point of the test).
// Kill only processes whose working directory is this test's unique temp dir.
function killLeftoverJobs() {
  const root = dir; // makeTmpDir returns the canonical path
  const pids = Bun.spawnSync(["pgrep", "-x", "sleep"]).stdout.toString().split("\n").filter(Boolean);
  for (const pid of pids) {
    const cwd = Bun.spawnSync(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"]).stdout.toString();
    if (cwd.split("\n").includes(`n${root}`)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

afterAll(async () => {
  killLeftoverJobs();
  await removeDir(dir);
});

async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(25);
  }
  return false;
}

const ctx = () => makeToolContext({ root: dir });

describe("Bash", () => {
  test("credentials are scrubbed from the child environment", async () => {
    const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_ADMIN_KEY", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE", "TROPOS_PROXY_TOKEN", "tropos_x_secret"];
    const saved = names.map((n) => [n, process.env[n]] as const);
    for (const n of names) process.env[n] = "sk-secret";
    process.env.TROPOS_PLAIN = "kept";
    try {
      const probe = names.map((n) => `[$${n}]`).join("") + "$TROPOS_PLAIN";
      const out = await bashTool.run({ command: `echo "${probe}"` }, ctx());
      expect(out.content).toBe("[][][][][][][]kept");
      expect(out.content).not.toContain("sk-secret");
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
      delete process.env.TROPOS_PLAIN;
    }
  });

  test("common third-party credentials are scrubbed too", async () => {
    const names = ["GITHUB_TOKEN", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "PGPASSWORD"];
    const saved = [...names, "TROPOS_KEEP_ME"].map((n) => [n, process.env[n]] as const);
    for (const n of names) process.env[n] = "sk-secret";
    process.env.TROPOS_KEEP_ME = "kept";
    try {
      const probe = names.map((n) => `[$${n}]`).join("") + "$TROPOS_KEEP_ME";
      const out = await bashTool.run({ command: `echo "${probe}"` }, ctx());
      expect(out.content).toBe("[][][][][][][]kept");
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });

  test("isSecretEnvName: credential-shaped names, not everyday ones", () => {
    const secret = [
      "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "NPM_TOKEN", "HF_TOKEN", "VERCEL_TOKEN", "SLACK_BOT_TOKEN", "NODE_AUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID", "OPENAI_API_KEY", "STRIPE_SECRET_KEY", "SENDGRID_APIKEY",
      "PGPASSWORD", "MYSQL_PWD", "DB_PASSWORD", "GOOGLE_APPLICATION_CREDENTIALS", "SSH_PRIVATE_KEY", "CLIENT_SECRET", "npm_config__authtoken",
      "ANTHROPIC_API_KEY", "ANTHROPIC_IDENTITY_TOKEN_FILE", "TROPOS_PROXY_TOKEN",
    ];
    const plain = [
      "PATH", "HOME", "SHELL", "TERM", "LANG", "USER", "PWD", "EDITOR", "SSH_AUTH_SOCK", "GPG_TTY", "TOKENIZERS_PARALLELISM",
      "KEYTIMEOUT", "NODE_ENV", "AWS_REGION", "AWS_PROFILE", "GIT_AUTHOR_NAME", "XAUTHORITY", "ANTHROPIC_BASE_URL", "TROPOS_HOME",
    ];
    expect(secret.filter((n) => !isSecretEnvName(n))).toEqual([]);
    expect(plain.filter((n) => isSecretEnvName(n))).toEqual([]);
  });

  test("returns stdout", async () => {
    const out = await bashTool.run({ command: "echo hello" }, ctx());
    expect(out.content).toBe("hello");
    expect(out.isError).toBeUndefined();
  });

  test("labels stderr and reports non-zero exit codes", async () => {
    const out = await bashTool.run({ command: "echo oops >&2; exit 3" }, ctx());
    expect(out.content).toBe("[stderr]\noops\n[exit code 3]");
    expect(out.isError).toBe(true);
  });

  test("no output", async () => {
    expect((await bashTool.run({ command: "true" }, ctx())).content).toBe("(no output)");
  });

  test("cd persists between calls", async () => {
    const c = ctx();
    await bashTool.run({ command: "cd sub" }, c);
    expect(c.cwd()).toBe(join(dir, "sub"));
    expect((await bashTool.run({ command: "pwd -P" }, c)).content).toBe(join(dir, "sub"));
  });

  test("cd outside the project is not kept", async () => {
    const c = ctx();
    const out = await bashTool.run({ command: "cd / && pwd" }, c);
    expect(c.cwd()).toBe(dir);
    expect(out.content).toContain("outside the project");
  });

  test("times out and kills the process", async () => {
    const started = Date.now();
    const out = await bashTool.run({ command: "sleep 20", timeout_ms: 1000 }, ctx());
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.content).toContain("timed out");
    expect(out.isError).toBe(true);
  });

  test("timeout kills the whole process group", async () => {
    const pidFile = join(dir, "bg.pid");
    await bashTool.run({ command: `sleep 20 & echo $! > ${pidFile}; sleep 20`, timeout_ms: 1000 }, ctx());
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    expect(await waitUntilGone(pid, 2000)).toBe(true);
  });

  test("a command that ignores SIGTERM is still killed", async () => {
    const pidFile = join(dir, "term.pid");
    const started = Date.now();
    await bashTool.run({ command: `trap '' TERM; sleep 40 & echo $! > ${pidFile}; wait`, timeout_ms: 1000 }, ctx());
    expect(Date.now() - started).toBeLessThan(7000);
    expect(await waitUntilGone(Number(readFileSync(pidFile, "utf8").trim()), 2000)).toBe(true);
 }, 10_000); // needs the 5 s SIGKILL grace period


  test("a finished call does not wait for the drain delay", async () => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await bashTool.run({ command: "true" }, ctx());
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[1]).toBeLessThan(150);
  });

  test("background jobs can still write after the call returns", async () => {
    const marker = join(dir, "late-marker");
    const out = await bashTool.run({ command: `(sleep 1; echo late && touch ${marker}) & echo started` }, ctx());
    expect(out.content).toBe("started");
    expect(existsSync(marker)).toBe(false);
    await Bun.sleep(1600);
    expect(existsSync(marker)).toBe(true);
  });

  test("a background job doesn't keep the call open", async () => {
    const started = Date.now();
    const out = await bashTool.run({ command: "sleep 20 & echo started" }, ctx());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.content).toContain("started");
  });

  test("abort interrupts the command", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const t = Date.now();
    const out = await bashTool.run({ command: "sleep 20" }, makeToolContext({ root: dir, signal: controller.signal }));
    expect(Date.now() - t).toBeLessThan(2000);
    expect(out.content).toContain("[interrupted by user]");
    expect(out.isError).toBe(true);
  });

  test("long output is truncated in the middle", async () => {
    const out = await bashTool.run({ command: "head -c 100000 /dev/zero | tr '\\0' 'a'" }, ctx());
    expect(String(out.content).length).toBeLessThan(16_000);
    expect(out.content).toContain("characters truncated");
  });

  test("a cwd marker a sandboxed command turned into a FIFO or a link to /dev/zero neither hangs nor floods the tool", async () => {
    for (const plant of ["fifo", "zero"] as const) {
      const host = join(dir, `marker-${plant}`);
      if (plant === "fifo") expect(Bun.spawnSync(["mkfifo", host]).exitCode).toBe(0);
      else symlinkSync("/dev/zero", host);
      // The script writes its marker elsewhere; the host side finds what the command planted.
      const exec: ExecBackend = {
        kind: "local",
        spawn: (opts) => localBackend.spawn(opts),
        signal: (child, sig) => localBackend.signal(child, sig),
        alive: (child) => localBackend.alive(child),
        close: () => localBackend.close(),
        cwdMarker: () => ({ inside: "/dev/null", host }),
      };
      const c = makeToolContext({ root: dir, exec });
      const out = await bashTool.run({ command: "echo ran" }, c);
      expect(out.content).toBe("ran");
      expect(c.cwd()).toBe(dir);
    }
  });

  test("subject is the command and the working directory it runs in", () => {
    expect(bashTool.subject({ command: "ls" }, dir)).toEqual({ command: "ls", paths: [], cwd: dir });
  });
});

describe("Bash tool documentation", () => {
  test("states the real per-stream output cap and does not promise the model's text reaches the user", () => {
    expect(bashTool.description).toContain("Output over 15,000 characters per stream (stdout/stderr)");
    expect(bashTool.description).not.toContain("30,000");
    const described = JSON.stringify(toInputSchema(bashTool.schema));
    expect(described).toContain("A few words on what the command does.");
    expect(described).not.toContain("shown to the user");
  });
});
