// src/remote/tailscale.ts — phone access through `tailscale serve`: the dashboard stays bound to 127.0.0.1 and Tailscale
// publishes it, with HTTPS, to the owner's own tailnet only. Never `funnel` (that would put it on the internet).
import type { Runner } from "../doctor/types";

export type TailscaleRunner = Pick<Runner, "exec">;

/** A failure whose message is shown to the owner as is. */
export class TailscaleError extends Error {}

/** The HTTPS ports `tailscale serve` accepts, in the order we try them. */
export const SERVE_PORTS = [443, 8443, 10000] as const;

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  dnsName?: string;
}

const CLI = "tailscale";

/** A missing binary, or a wrapper script whose app is gone (this Mac's /usr/local/bin/tailscale), is "not installed". */
function missing(r: { code: number | null; stderr: string; error?: string }): boolean {
  return Boolean(r.error && /ENOENT|not found/i.test(r.error)) || r.code === 127 || /No such file or directory/i.test(r.stderr);
}

export async function tailscaleStatus(runner: TailscaleRunner): Promise<TailscaleStatus> {
  const r = await runner.exec(CLI, ["status", "--json"], 8_000);
  if (missing(r)) return { installed: false, running: false };
  if (r.code !== 0) return { installed: true, running: false };
  try {
    const json = JSON.parse(r.stdout) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    const name = typeof json.Self?.DNSName === "string" ? json.Self.DNSName.replace(/\.$/, "") : "";
    if (json.BackendState === "Running" && name) return { installed: true, running: true, dnsName: name };
  } catch {
    // Unreadable output reads as "not running".
  }
  return { installed: true, running: false };
}

interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  /** `<dns>:<port>` → true while Funnel publishes that port to the whole internet. */
  AllowFunnel?: Record<string, unknown>;
}

const isOurs = (proxy: string | undefined, port: number): boolean => proxy === `http://127.0.0.1:${port}` || proxy === `http://localhost:${port}`;

/** The current serve config. Unreadable output throws: guessing "empty" could reuse or overwrite a port we can't see. */
async function readServeConfig(runner: TailscaleRunner): Promise<ServeConfig> {
  const current = await runner.exec(CLI, ["serve", "status", "--json"], 8_000);
  const unreadable = new TailscaleError("Tailscale: couldn't read the current serve config, so nothing was changed. Check that Tailscale is running and try again.");
  if (current.code !== 0) throw unreadable;
  try {
    const parsed = JSON.parse(current.stdout.trim() || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ServeConfig;
  } catch {
    // falls through
  }
  throw unreadable;
}

const funnelled = (config: ServeConfig, dns: string, port: number): boolean => config.AllowFunnel?.[`${dns}:${port}`] === true;

/** Whether `httpsPort` on this machine's tailnet name is open to the internet. Unreadable state reads as "no" (callers only warn). */
export async function serveFunnelled(runner: TailscaleRunner, httpsPort: number): Promise<boolean> {
  const status = await tailscaleStatus(runner);
  if (!status.running || !status.dnsName) return false;
  try {
    return funnelled(await readServeConfig(runner), status.dnsName, httpsPort);
  } catch {
    return false;
  }
}

export async function enableServe(runner: TailscaleRunner, port: number): Promise<{ url: string; httpsPort: number }> {
  const status = await tailscaleStatus(runner);
  if (!status.installed) throw new TailscaleError("Tailscale isn't installed on this computer. Install it from https://tailscale.com/download, sign in, and try again.");
  if (!status.running || !status.dnsName) throw new TailscaleError("Tailscale isn't running or isn't signed in. Open Tailscale, sign in, and try again.");
  const dns = status.dnsName;

  const config = await readServeConfig(runner);
  const urlFor = (p: number) => `https://${dns}${p === 443 ? "" : `:${p}`}/`;
  const ours = SERVE_PORTS.find((p) => isOurs(config.Web?.[`${dns}:${p}`]?.Handlers?.["/"]?.Proxy, port));
  if (ours !== undefined) {
    // Funnel would make the dashboard reachable from anywhere; only the owner can turn it off.
    if (funnelled(config, dns, ours)) {
      throw new TailscaleError(`Port ${ours} on your tailnet name is open to the whole internet (Tailscale Funnel). Turn Funnel off for that port (\`tailscale funnel --https=${ours} off\`) and try again.`);
    }
    return { url: urlFor(ours), httpsPort: ours };
  }
  const free = SERVE_PORTS.find((p) => !config.TCP?.[String(p)] && !config.Web?.[`${dns}:${p}`] && !funnelled(config, dns, p));
  if (free === undefined) {
    throw new TailscaleError("Ports 443, 8443 and 10000 on your tailnet name are already served by something else. Free one in `tailscale serve status`.");
  }
  const r = await runner.exec(CLI, ["serve", "--bg", `--https=${free}`, `http://127.0.0.1:${port}`], 15_000);
  if (r.code !== 0) throw new TailscaleError(r.stderr.trim() || r.error || "tailscale serve failed.");
  return { url: urlFor(free), httpsPort: free };
}

export async function disableServe(runner: TailscaleRunner, httpsPort: number): Promise<void> {
  const r = await runner.exec(CLI, ["serve", `--https=${httpsPort}`, "off"], 15_000);
  if (r.code !== 0) throw new TailscaleError(r.stderr.trim() || r.error || "tailscale serve off failed.");
}
