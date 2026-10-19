// src/service/types.ts — running the gateway as a background service.
export interface ServiceSpec {
  /** The command the service runs, e.g. ["/home/u/.local/bin/tcode", "gateway"]. */
  programArguments: string[];
  workingDirectory: string;
  logPath: string;
  env: Record<string, string>;
}

export interface RunResult {
  code: number;
  output: string;
}
/** Runs a command and returns its exit code and combined output. Tests replace it; nothing real runs in them. */
export type ServiceRunner = (command: string[]) => Promise<RunResult>;

/** What a manager needs from the machine, all injectable. */
export interface ServiceDeps {
  platform?: NodeJS.Platform;
  userHome: string;
  uid: number;
  /** The login name, for the lingering hint (systemd). */
  user?: string;
  run?: ServiceRunner;
  /** Test seam for the waits while launchd loads and unloads the job. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ServiceStatus {
  manager: "launchd" | "systemd" | "none";
  installed: boolean;
  running: boolean;
  pid?: number;
  /** The plist or unit file. */
  unitPath?: string;
}

export interface ServiceManager {
  readonly manager: ServiceStatus["manager"];
  /** Writes the unit, loads it and starts it (replacing a loaded copy). */
  install(spec: ServiceSpec): Promise<{ unitPath: string; /** Something the owner should do next, e.g. enable lingering. */ hint?: string }>;
  /** Stops and removes the unit. `removed` is false when nothing was installed. */
  uninstall(): Promise<{ removed: boolean }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
}
