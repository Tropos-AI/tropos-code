// src/service/launchd.ts — runs `tcode gateway` as a launchd agent so it starts at login and restarts if it dies.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ServiceError } from "./errors";
import { serviceEnv, programArguments } from "./spec";
import type { RunResult, ServiceDeps, ServiceManager, ServiceSpec, ServiceStatus } from "./types";

export const LAUNCHD_LABEL = "com.troposlabs.gateway";

export interface PlistOptions {
  label?: string;
  programArguments: string[];
  workingDirectory: string;
  logPath: string;
  env: Record<string, string>;
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderPlist(o: PlistOptions): string {
  const args = o.programArguments.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const env = Object.entries(o.env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(o.label ?? LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(o.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(o.logPath)}</string>
</dict>
</plist>
`;
}

export { programArguments };
export const agentEnv = serviceEnv;

export function plistPath(userHome: string, label = LAUNCHD_LABEL): string {
  return join(userHome, "Library", "LaunchAgents", `${label}.plist`);
}

export type LaunchctlResult = RunResult;
export type Launchctl = (args: string[]) => Promise<LaunchctlResult>;

export async function runCommand(command: string[]): Promise<RunResult> {
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, output: `${out}${err}`.trim() };
  } catch (e) {
    // The program isn't there (ENOENT): report it like a failed run rather than crash the caller.
    return { code: 127, output: (e as Error).message };
  }
}

export async function runLaunchctl(args: string[]): Promise<LaunchctlResult> {
  return runCommand(["launchctl", ...args]);
}

export interface LaunchdDeps {
  platform?: NodeJS.Platform;
  userHome: string;
  uid: number;
  launchctl?: Launchctl;
}

const domain = (uid: number) => `gui/${uid}`;

export class LaunchdError extends ServiceError {}

function requireMac(platform: NodeJS.Platform | undefined): void {
  if ((platform ?? process.platform) !== "darwin") {
    throw new LaunchdError("Running the gateway at login is set up with launchd, which only macOS has. Start it with `tcode gateway` instead.");
  }
}

/** Writes the plist and loads it (replacing a loaded one). */
export async function installAgent(o: PlistOptions, deps: LaunchdDeps): Promise<{ plist: string }> {
  requireMac(deps.platform);
  const launchctl = deps.launchctl ?? runLaunchctl;
  const label = o.label ?? LAUNCHD_LABEL;
  const path = plistPath(deps.userHome, label);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(dirname(o.logPath), { recursive: true, mode: 0o700 });
  await writeFile(path, renderPlist(o), { mode: 0o644 });
  // A previous copy may be loaded or not; both are fine.
  await launchctl(["bootout", `${domain(deps.uid)}/${label}`]);
  const loaded = await launchctl(["bootstrap", domain(deps.uid), path]);
  if (loaded.code !== 0) throw new LaunchdError(`launchctl bootstrap failed: ${loaded.output || `exit ${loaded.code}`}`);
  return { plist: path };
}

export async function uninstallAgent(deps: LaunchdDeps, label = LAUNCHD_LABEL): Promise<{ removed: boolean }> {
  requireMac(deps.platform);
  const launchctl = deps.launchctl ?? runLaunchctl;
  const path = plistPath(deps.userHome, label);
  await launchctl(["bootout", `${domain(deps.uid)}/${label}`]);
  const existed = existsSync(path);
  await rm(path, { force: true });
  return { removed: existed };
}

export interface AgentStatus {
  loaded: boolean;
  running: boolean;
  pid?: number;
}

export async function agentStatus(deps: LaunchdDeps, label = LAUNCHD_LABEL): Promise<AgentStatus> {
  requireMac(deps.platform);
  const launchctl = deps.launchctl ?? runLaunchctl;
  const res = await launchctl(["print", `${domain(deps.uid)}/${label}`]);
  if (res.code !== 0) return { loaded: false, running: false };
  const pid = /\bpid = (\d+)/.exec(res.output)?.[1];
  return pid ? { loaded: true, running: true, pid: Number(pid) } : { loaded: true, running: false };
}

/** The ServiceManager over launchd. */
export function launchdManager(deps: ServiceDeps): ServiceManager {
  const launchctl: Launchctl = (args) => (deps.run ?? runCommand)(["launchctl", ...args]);
  const d: LaunchdDeps = { platform: deps.platform, userHome: deps.userHome, uid: deps.uid, launchctl };
  const target = `${domain(deps.uid)}/${LAUNCHD_LABEL}`;
  const path = plistPath(deps.userHome);

  /** Loads the plist when it isn't loaded, so start/restart work after a stop. */
  const ensureLoaded = async (): Promise<void> => {
    if (!existsSync(path)) throw new LaunchdError("The gateway service isn't installed. Run: tcode gateway install");
    if ((await agentStatus(d)).loaded) return;
    const res = await launchctl(["bootstrap", domain(deps.uid), path]);
    if (res.code !== 0) throw new LaunchdError(`launchctl bootstrap failed: ${res.output || `exit ${res.code}`}`);
  };

  return {
    manager: "launchd",
    async install(spec: ServiceSpec) {
      const { plist } = await installAgent({ programArguments: spec.programArguments, workingDirectory: spec.workingDirectory, logPath: spec.logPath, env: spec.env }, d);
      return { unitPath: plist };
    },
    uninstall: () => uninstallAgent(d),
    async start() {
      requireMac(deps.platform);
      await ensureLoaded();
      const res = await launchctl(["kickstart", target]);
      if (res.code !== 0) throw new LaunchdError(`launchctl kickstart failed: ${res.output || `exit ${res.code}`}`);
    },
    async stop() {
      requireMac(deps.platform);
      // bootout, not kill: KeepAlive would start it again. The plist stays, so `start` and the next login load it.
      await launchctl(["bootout", target]);
    },
    async restart() {
      requireMac(deps.platform);
      await ensureLoaded();
      const res = await launchctl(["kickstart", "-k", target]);
      if (res.code !== 0) throw new LaunchdError(`launchctl kickstart failed: ${res.output || `exit ${res.code}`}`);
    },
    async status(): Promise<ServiceStatus> {
      requireMac(deps.platform);
      const a = await agentStatus(d);
      return { manager: "launchd", installed: existsSync(path), running: a.running, ...(a.pid !== undefined ? { pid: a.pid } : {}), unitPath: path };
    },
  };
}
