// src/doctor/testing.ts — fixtures for the doctor's tests: a throwaway home and a fake Runner. Never touches the real ~/.tropos.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, DoctorEnv, Finding, Report, Runner } from "./types";
import { runDoctor } from "./engine";
import type { DoctorOptions } from "./types";

export interface Fixture {
  root: string;
  /** TROPOS_HOME */
  home: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
  write(rel: string, content: string, mode?: number): Promise<string>;
  close(): Promise<void>;
}

export async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "tropos-doctor-"));
  const home = join(root, "tropos");
  const userHome = join(root, "user");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(userHome, { recursive: true });
  return {
    root,
    home,
    userHome,
    env: { HOME: userHome, TROPOS_HOME: home, PATH: "" },
    async write(rel, content, mode = 0o600) {
      const path = join(home, rel);
      await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
      await writeFile(path, content, { mode });
      return path;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

export const noDocker = { code: null, stdout: "", stderr: "", error: "docker: not found" };

export function fakeRunner(over: Partial<Runner> = {}): Runner {
  return {
    exec: async () => noDocker,
    fetch: (async () => {
      throw new Error("network is off in tests");
    }) as unknown as typeof fetch,
    pidAlive: () => false,
    listModels: async () => {
      throw new Error("no provider access in tests");
    },
    serviceStatus: async () => ({ manager: "none", installed: false, running: false }),
    listProjects: async () => [],
    sweepContainers: async () => 0,
    ...over,
  };
}

export function doctorEnv(fx: Fixture, over: Partial<DoctorEnv> = {}): DoctorEnv {
  return { home: fx.home, userHome: fx.userHome, env: fx.env, cwd: fx.root, deep: false, platform: "linux", now: () => Date.UTC(2026, 9, 15), runner: fakeRunner(), ...over };
}

/** Runs one check (and its fixes, when asked) through the engine so `area` and `fixed` are set the way the CLI sees them. */
export function runOne(fx: Fixture, check: Check, opts: Partial<DoctorOptions> = {}): Promise<Report> {
  return runDoctor({
    home: fx.home,
    userHome: fx.userHome,
    env: fx.env,
    cwd: fx.root,
    now: () => Date.UTC(2026, 9, 15),
    platform: "linux",
    checks: [check],
    only: check.id,
    ...opts,
    runner: fakeRunner(opts.runner),
  });
}

export const byId = (r: Report, id: string): Finding | undefined => r.findings.find((f) => f.id === id);
