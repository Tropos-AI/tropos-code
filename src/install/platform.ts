// src/install/platform.ts
import { readdirSync } from "node:fs";
import { InstallError } from "./errors";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** What `uname -s`, `uname -m`, the Rosetta sysctl and musl detection report; install.sh applies the same rules. */
export interface PlatformProbe {
  os: string;
  machine: string;
  rosetta: boolean;
  musl: boolean;
}

export function platformFromProbe(p: PlatformProbe): Platform {
  const os = p.os === "Darwin" ? "darwin" : p.os === "Linux" ? "linux" : undefined;
  if (!os) throw new InstallError("local", `unsupported operating system: ${p.os}`);
  const arch = p.machine === "x86_64" || p.machine === "amd64" ? "x64" : p.machine === "arm64" || p.machine === "aarch64" ? "arm64" : undefined;
  if (!arch) throw new InstallError("local", `unsupported CPU architecture: ${p.machine}`);
  if (os === "darwin") return arch === "x64" && p.rosetta ? "darwin-arm64" : `darwin-${arch}`;
  return p.musl ? `linux-${arch}-musl` : `linux-${arch}`;
}

export interface ProbeDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  run?: (cmd: string[]) => string | null;
  libDir?: string;
}

function runQuiet(cmd: string[]): string | null {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return r.stdout.toString() + r.stderr.toString();
  } catch {
    return null;
  }
}

function hasMuslLoader(libDir: string): boolean {
  try {
    return readdirSync(libDir).some((f) => /^ld-musl-.+\.so\.1$/.test(f));
  } catch {
    return false;
  }
}

export function probeHost(deps: ProbeDeps = {}): PlatformProbe {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const run = deps.run ?? runQuiet;
  const os = platform === "darwin" ? "Darwin" : platform === "linux" ? "Linux" : platform;
  const machine = arch === "x64" ? "x86_64" : arch;
  const rosetta = platform === "darwin" && arch === "x64" && run(["sysctl", "-n", "sysctl.proc_translated"])?.trim() === "1";
  const musl = platform === "linux" && (hasMuslLoader(deps.libDir ?? "/lib") || /musl/i.test(run(["ldd", "/bin/sh"]) ?? ""));
  return { os, machine, rosetta, musl };
}

export function detectPlatform(deps?: ProbeDeps): Platform {
  return platformFromProbe(probeHost(deps));
}
