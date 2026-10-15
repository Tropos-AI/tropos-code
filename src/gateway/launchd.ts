// src/gateway/launchd.ts — runs `tcode gateway` as a launchd agent so it starts at login and restarts if it dies.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const LAUNCHD_LABEL = "com.troposlabs.gateway";

/** launchd gives agents a bare PATH; Docker lives in one of these. */
const AGENT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

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

/**
 * The command launchd runs. A compiled `tcode` is its own executable; run from source, the executable is bun and
 * the script has to come with it.
 */
export function programArguments(execPath: string, scriptPath: string | undefined): string[] {
  const runtime = basename(execPath).toLowerCase();
  return runtime === "bun" || runtime === "node" ? [execPath, scriptPath ?? "", "gateway"].filter(Boolean) : [execPath, "gateway"];
}

export function plistPath(userHome: string, label = LAUNCHD_LABEL): string {
  return join(userHome, "Library", "LaunchAgents", `${label}.plist`);
}

export interface LaunchctlResult {
  code: number;
  output: string;
}
export type Launchctl = (args: string[]) => Promise<LaunchctlResult>;

export async function runLaunchctl(args: string[]): Promise<LaunchctlResult> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: `${out}${err}`.trim() };
}

export interface LaunchdDeps {
  platform?: NodeJS.Platform;
  userHome: string;
  uid: number;
  launchctl?: Launchctl;
}

const domain = (uid: number) => `gui/${uid}`;

export class LaunchdError extends Error {}

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

export function agentEnv(env: NodeJS.ProcessEnv, userHome: string): Record<string, string> {
  const out: Record<string, string> = { HOME: userHome, PATH: AGENT_PATH };
  if (env.TROPOS_HOME) out.TROPOS_HOME = env.TROPOS_HOME;
  return out;
}
