// src/exec/local.ts — runs commands on the host, exactly as bash.ts always has.
import { type ChildProcess, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CwdMarker, ExecBackend, ExecSpawn } from "./backend";

export class LocalBackend implements ExecBackend {
  readonly kind = "local" as const;

  spawn(opts: ExecSpawn): ChildProcess {
    return spawn(opts.shell, ["-c", opts.script], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  cwdMarker(id: string): CwdMarker {
    const path = join(tmpdir(), `tropos-cwd-${id}`);
    return { inside: path, host: path };
  }

  signal(child: ChildProcess, sig: NodeJS.Signals): void {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      // already gone
    }
  }

  alive(child: ChildProcess): boolean {
    try {
      if (!child.pid) return false;
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {}
}

export const localBackend = new LocalBackend();
