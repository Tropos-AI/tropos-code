// src/doctor/runner.ts — the real processes, network and services behind the doctor's Runner.
import { spawn } from "node:child_process";
import { ProviderRouter } from "../providers/router";
import type { Runner } from "./types";
import { pidAlive } from "./util";

function exec(cmd: string, args: string[], timeoutMs = 10_000): ReturnType<Runner["exec"]> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: Awaited<ReturnType<Runner["exec"]>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ code: null, stdout, stderr, error: (err as Error).message });
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr, error: `${cmd} timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.once("error", (err: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, error: err.code === "ENOENT" ? `${cmd}: not found` : err.message }));
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

export function defaultRunner(): Runner {
  return {
    exec,
    fetch: ((input, init) => fetch(input, init)) as typeof fetch,
    pidAlive,
    listModels: ({ home, env, settings, id, signal }) => new ProviderRouter({ home, env, settings }).models(id, signal),
    // Loaded on demand: the service and project modules are only needed by the checks that use them.
    serviceStatus: async () => (await import("../service")).serviceManager().status(),
    listProjects: async (home) => (await import("../gateway/projects")).listProjects(home),
    sweepContainers: async () => (await import("../exec/docker")).sweepLeftoverContainers(),
  };
}
