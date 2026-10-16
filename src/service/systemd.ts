// src/service/systemd.ts — runs `tcode gateway` as a systemd user unit so it starts at login and restarts if it dies.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ServiceError } from "./errors";
import { runCommand } from "./launchd";
import type { ServiceDeps, ServiceManager, ServiceSpec, ServiceStatus } from "./types";

export const SYSTEMD_UNIT = "tropos-gateway.service";

export class SystemdError extends ServiceError {}

export function unitPath(userHome: string): string {
  return join(userHome, ".config", "systemd", "user", SYSTEMD_UNIT);
}

/** One word of an ExecStart line: double-quoted, with the characters systemd would otherwise interpret escaped. */
function quoteWord(word: string): string {
  return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/** A value inside `Environment="K=V"`: quotes and backslashes escaped, `%` doubled (specifiers). */
function quoteEnv(key: string, value: string): string {
  return `"${`${key}=${value}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

const noNewlines = (text: string) => text.replace(/[\r\n]+/g, " ");

export function renderUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `Environment=${quoteEnv(k, noNewlines(v))}`);
  return [
    "[Unit]",
    "Description=Tropos Code gateway",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${spec.programArguments.map((a) => quoteWord(noNewlines(a))).join(" ")}`,
    `WorkingDirectory=${noNewlines(spec.workingDirectory).replace(/%/g, "%%")}`,
    ...env,
    "Restart=always",
    "RestartSec=10",
    `StandardOutput=append:${noNewlines(spec.logPath)}`,
    `StandardError=append:${noNewlines(spec.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function loginName(deps: ServiceDeps): string {
  if (deps.user) return deps.user;
  try {
    return userInfo().username;
  } catch {
    return "$USER";
  }
}

/** The ServiceManager over `systemctl --user`. */
export function systemdManager(deps: ServiceDeps): ServiceManager {
  const run = deps.run ?? runCommand;
  const systemctl = (...args: string[]) => run(["systemctl", "--user", ...args]);
  const path = unitPath(deps.userHome);

  const requireLinux = () => {
    if ((deps.platform ?? process.platform) !== "linux") throw new SystemdError("systemd user units only exist on Linux. Start the gateway with `tcode gateway` instead.");
  };
  const must = async (what: string, ...args: string[]) => {
    const res = await systemctl(...args);
    if (res.code !== 0) throw new SystemdError(`systemctl ${what} failed: ${res.output || `exit ${res.code}`}`);
  };
  const requireInstalled = () => {
    if (!existsSync(path)) throw new SystemdError("The gateway service isn't installed. Run: tcode gateway install");
  };

  return {
    manager: "systemd",
    async install(spec) {
      requireLinux();
      const wasActive = (await systemctl("is-active", SYSTEMD_UNIT)).output.trim() === "active";
      await mkdir(dirname(path), { recursive: true });
      await mkdir(dirname(spec.logPath), { recursive: true, mode: 0o700 });
      await writeFile(path, renderUnit(spec), { mode: 0o644 });
      await must("daemon-reload", "daemon-reload");
      await must("enable", "enable", "--now", SYSTEMD_UNIT);
      // `enable --now` leaves a running copy on the old unit; a restart picks the new one up.
      if (wasActive) await must("restart", "restart", SYSTEMD_UNIT);
      // Without lingering, a user's units stop at logout and don't start at boot.
      const name = loginName(deps);
      const linger = await run(["loginctl", "show-user", name, "-p", "Linger"]);
      const hint = /Linger=no/i.test(linger.output) ? `The gateway stops when you log out. To keep it running: loginctl enable-linger ${name}` : undefined;
      return { unitPath: path, ...(hint ? { hint } : {}) };
    },
    async uninstall() {
      requireLinux();
      const existed = existsSync(path);
      if (existed) await systemctl("disable", "--now", SYSTEMD_UNIT);
      await rm(path, { force: true });
      if (existed) await systemctl("daemon-reload");
      return { removed: existed };
    },
    async start() {
      requireLinux();
      requireInstalled();
      await must("start", "start", SYSTEMD_UNIT);
    },
    async stop() {
      requireLinux();
      requireInstalled();
      await must("stop", "stop", SYSTEMD_UNIT);
    },
    async restart() {
      requireLinux();
      requireInstalled();
      await must("restart", "restart", SYSTEMD_UNIT);
    },
    async status(): Promise<ServiceStatus> {
      requireLinux();
      const installed = existsSync(path);
      const active = (await systemctl("is-active", SYSTEMD_UNIT)).output.trim() === "active";
      let pid: number | undefined;
      if (active) {
        const shown = await systemctl("show", "-p", "MainPID", SYSTEMD_UNIT);
        const n = Number(/MainPID=(\d+)/.exec(shown.output)?.[1]);
        if (Number.isInteger(n) && n > 0) pid = n;
      }
      return { manager: "systemd", installed, running: active, ...(pid !== undefined ? { pid } : {}), unitPath: path };
    },
  };
}
