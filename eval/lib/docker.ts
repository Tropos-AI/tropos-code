// eval/lib/docker.ts

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was killed for running past its time limit. */
  timedOut: boolean;
  seconds: number;
}

/** Exit status of `timeout` when it had to stop the command. */
const TIMEOUT_EXIT = 124;
const KILLED_EXIT = 137;

async function docker(args: string[], opts: { env?: Record<string, string | undefined> } = {}): Promise<ExecResult> {
  const started = performance.now();
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr, timedOut: false, seconds: (performance.now() - started) / 1000 };
}

async function dockerOk(args: string[]): Promise<string> {
  const r = await docker(args);
  if (r.exitCode !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed (${r.exitCode}): ${r.stderr.trim()}`);
  return r.stdout;
}

/** Architecture of the Docker engine, as a Bun compile target suffix ("arm64" or "x64"). */
export async function engineArch(): Promise<"arm64" | "x64"> {
  const arch = (await dockerOk(["info", "--format", "{{.Architecture}}"])).trim();
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  if (arch === "x86_64" || arch === "amd64") return "x64";
  throw new Error(`unsupported Docker architecture: ${arch}`);
}

export async function buildImage(tag: string, contextDir: string, buildArgs: Record<string, string>): Promise<void> {
  const args = ["build", "-q", "-t", tag, ...Object.entries(buildArgs).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]), contextDir];
  await dockerOk(args);
}

/**
 * A long-lived task container. Files go in and out with `docker cp`, never bind mounts, so ownership
 * works the same on macOS and Linux hosts. Commands run as the image's unprivileged `agent` user.
 */
export class Container {
  private constructor(readonly id: string) {}

  static async start(image: string, name: string): Promise<Container> {
    // The keep-alive process runs as root, so every process of the agent user can be killed at once.
    const id = (await dockerOk(["run", "-d", "--rm", "--name", name, "--init", "-u", "root", image, "sleep", "infinity"])).trim();
    return new Container(id);
  }

  /** Copies a host directory's contents into `dest` and hands it to the agent user. */
  async copyIn(hostDir: string, dest: string): Promise<void> {
    await dockerOk(["exec", "-u", "root", this.id, "mkdir", "-p", dest]);
    await dockerOk(["cp", `${hostDir}/.`, `${this.id}:${dest}`]);
    await dockerOk(["exec", "-u", "root", this.id, "chown", "-R", "agent:agent", dest]);
  }

  async copyFileIn(hostFile: string, dest: string, mode = "0755"): Promise<void> {
    await dockerOk(["cp", hostFile, `${this.id}:${dest}`]);
    await dockerOk(["exec", "-u", "root", this.id, "chmod", mode, dest]);
  }

  /**
   * Runs `script` with bash in `cwd`, killed after `timeoutSec`. `env` values are passed by name
   * from this process's environment so they never appear in a command line.
   */
  async exec(script: string, opts: { cwd: string; timeoutSec: number; env?: Record<string, string | undefined>; user?: string }): Promise<ExecResult> {
    const envArgs = Object.keys(opts.env ?? {}).flatMap((name) => ["-e", name]);
    const r = await docker(
      ["exec", "-u", opts.user ?? "agent", "-w", opts.cwd, ...envArgs, this.id, "timeout", "-k", "10", String(opts.timeoutSec), "bash", "-lc", script],
      { env: opts.env },
    );
    return { ...r, timedOut: r.exitCode === TIMEOUT_EXIT || r.exitCode === KILLED_EXIT };
  }

  async disconnectNetwork(): Promise<void> {
    const networks = (await dockerOk(["inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}", this.id])).trim().split(/\s+/);
    for (const net of networks.filter(Boolean)) await dockerOk(["network", "disconnect", "-f", net, this.id]);
  }

  async remove(): Promise<void> {
    await docker(["rm", "-f", this.id]);
  }
}
