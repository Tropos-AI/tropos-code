// src/web/admin/context.ts — what the admin handlers may use. Everything outside the process (processes, the network,
// the clock, the file system roots) is injectable so handlers are tested against temp directories and fakes.
import type { AdminMethod, AdminParams, AdminResult } from "./api";

export interface AdminContext {
  /** Tropos's data directory (TROPOS_HOME or ~/.tropos). */
  home: string;
  /** The user's home directory (shell rc files, ~/.local). */
  userHome: string;
  env: NodeJS.ProcessEnv;
  version: string;
  execPath: string;
  scriptPath?: string;
  cwd: string;
  now(): number;
  /** Which OS confinement this machine has (default: the real probe). Injectable for tests. */
  probeConfinement?: () => Promise<"sandbox-exec" | "bwrap" | null>;
  fetch: typeof fetch;
  /**
   * Things only the running gateway can do. Absent in a plain `tcode web`, where the matching admin calls answer
   * with a clear "start the gateway" message instead.
   */
  gateway?: {
    runCronNow(jobId: string): Promise<void>;
    /** Re-reads gateway.json / projects after the admin API changed them. */
    reload(): Promise<void>;
    /** Logs out open dashboard tabs whose device was revoked. */
    devicesChanged(): Promise<void>;
  };
}

/** Who made an admin call: the dashboard device its socket logged in as. */
export interface AdminCaller {
  deviceId: string;
}

export type AdminHandler<M extends AdminMethod> = (params: AdminParams<M>, caller?: AdminCaller) => Promise<AdminResult<M>>;
export type AdminHandlers = { [M in AdminMethod]?: AdminHandler<M> };

/** A failure whose message is shown to the owner as is. */
export class AdminError extends Error {}
