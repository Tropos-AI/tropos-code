// src/web/admin/host-testkit.ts — fixtures for the host-area admin tests: a throwaway home, a context, fakes.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir } from "../../../test/helpers/tmp";
import type { RunResult } from "../../doctor/types";
import type { ServiceManager, ServiceSpec, ServiceStatus } from "../../service";
import type { AdminContext } from "./context";
import { AdminError } from "./context";
import { createAdmin, type Admin } from "./index";
import type { AdminHandlers } from "./context";

export interface Kit {
  root: string;
  home: string;
  userHome: string;
  ctx: AdminContext;
  reloads: number;
  close(): Promise<void>;
}

export async function makeKit(over: Partial<AdminContext> = {}): Promise<Kit> {
  const root = await makeTmpDir("tropos-admin-");
  const home = join(root, "tropos");
  const userHome = join(root, "user");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(userHome, { recursive: true });
  const kit: Kit = {
    root,
    home,
    userHome,
    reloads: 0,
    close: () => rm(root, { recursive: true, force: true }),
    ctx: {
      home,
      userHome,
      env: { HOME: userHome, TROPOS_HOME: home, PATH: "" },
      version: "1.2.3",
      execPath: "/usr/local/bin/tcode",
      cwd: root,
      now: () => Date.UTC(2026, 9, 15),
      fetch: (async () => {
        throw new Error("network is off in tests");
      }) as unknown as typeof fetch,
      gateway: {
        runCronNow: async () => {},
        reload: async () => {
          kit.reloads++;
        },
        devicesChanged: async () => {},
      },
      ...over,
    },
  };
  return kit;
}

export function fakeService(initial: Partial<ServiceStatus> = {}): ServiceManager & { calls: string[]; specs: ServiceSpec[] } {
  const state: ServiceStatus = { manager: "launchd", installed: false, running: false, ...initial };
  const calls: string[] = [];
  const specs: ServiceSpec[] = [];
  return {
    manager: state.manager,
    calls,
    specs,
    async install(spec) {
      calls.push("install");
      specs.push(spec);
      state.installed = state.running = true;
      state.unitPath = "/fake/unit.plist";
      return { unitPath: "/fake/unit.plist" };
    },
    async uninstall() {
      calls.push("uninstall");
      const removed = state.installed;
      state.installed = state.running = false;
      return { removed };
    },
    async start() {
      calls.push("start");
      state.running = true;
    },
    async stop() {
      calls.push("stop");
      state.running = false;
    },
    async restart() {
      calls.push("restart");
      state.running = true;
    },
    async status() {
      return { ...state };
    },
  };
}

export const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
export const fail = (stderr = "boom"): RunResult => ({ code: 1, stdout: "", stderr });

/** An admin with `extra` handlers replacing the real ones, like the dispatcher tests need. */
export const adminWith = (kit: Kit, extra: AdminHandlers): Admin => createAdmin(kit.ctx, extra);

/** Calls a method and returns the error message instead of throwing. */
export async function failure(admin: Admin, method: string, params?: unknown): Promise<string> {
  try {
    await admin.handle(method, params);
  } catch (e) {
    if (e instanceof AdminError) return e.message;
    throw e;
  }
  throw new Error(`${method} should have failed`);
}
