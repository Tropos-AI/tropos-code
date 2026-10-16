// src/cli/lifecycle/status.ts — `tcode status`: one screen about this Tropos install and its gateway.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readSettingsFile } from "../../config/settings";
import { runDoctor } from "../../doctor/engine";
import { parseFlags } from "../../doctor/flags";
import { defaultRunner } from "../../doctor/runner";
import type { DoctorOptions, Runner } from "../../doctor/types";
import { countJobs, updateReadyVersion } from "../../doctor/status-data";
import { isRecord, readJsonFile, readStateFile } from "../../doctor/util";
import { resolveLayout } from "../../install/layout";
import { readState } from "../../install/state";
import { ProviderRouter } from "../../providers/router";
import type { ServiceStatus } from "../../service/types";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode status [options]

Shows the version, update state, background service, gateway, providers, Docker,
projects, paired senders, last session, scheduled jobs and a doctor summary.
Makes no network calls unless --deep is given.

Options:
  --deep    let the doctor make its network checks (provider listings, Telegram)
  --all     include secrets that are normally hidden (the web link's token)
  --json    print the status as JSON
  --help    show this text
`;

export interface Status {
  version: string;
  channel: string;
  autoUpdates: boolean;
  install: { current: string | null; previous: string | null; pending: string | null; lastCheck: string | null; lastUpdated: string | null; updateReady: string | null };
  service: ServiceStatus | { error: string };
  gateway: { running: boolean; pid?: number; startedAt?: string };
  web: { url: string; token?: string } | null;
  providers: string[];
  docker: { ok: boolean; detail: string };
  projects: { count: number; default: string };
  paired: number;
  lastSession: string | null;
  cronJobs: number | null;
  doctor: { errors: number; warnings: number; fixable: number };
}

async function newestSession(home: string): Promise<number | null> {
  let newest: number | null = null;
  for (const project of await readdir(join(home, "projects")).catch(() => [])) {
    for (const file of await readdir(join(home, "projects", project)).catch(() => [])) {
      if (!file.endsWith(".jsonl")) continue;
      const m = (await stat(join(home, "projects", project, file)).catch(() => null))?.mtimeMs;
      if (m !== undefined && (newest === null || m > newest)) newest = m;
    }
  }
  return newest;
}

export async function gatherStatus(ctx: LifecycleContext, opts: { deep: boolean; all: boolean; runner?: Partial<Runner> } & Pick<DoctorOptions, "checks">): Promise<Status> {
  const runner = { ...defaultRunner(), ...opts.runner };
  const layout = resolveLayout(ctx.env, ctx.userHome);
  const settings = await readSettingsFile(join(ctx.home, "settings.json")).catch(() => null);
  const st = await readState(layout).catch(() => null);
  const state = st?.kind === "ok" ? st.state : null;
  // A newer directory under versions/ than the running version is an update waiting for a restart.
  const updateReady = await updateReadyVersion(ctx.env, ctx.userHome, ctx.version);

  const service = await runner.serviceStatus().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  const gw = await readStateFile(ctx.home);
  const running = gw ? runner.pidAlive(gw.pid) : false;
  let web: Status["web"] = null;
  if (running && gw?.webPort) {
    const url = `http://127.0.0.1:${gw.webPort}/`;
    const token = opts.all ? (await readFile(join(ctx.home, "gateway", "token"), "utf8").catch(() => "")).trim() : "";
    web = token ? { url: `${url}?token=${token}`, token } : { url };
  }

  const router = new ProviderRouter({ home: ctx.home, env: ctx.env, settings: settings?.providers ?? {} });
  const providers = (await router.status().catch(() => [])).filter((p) => p.key !== null).map((p) => p.info.name);
  const docker = await runner.exec("docker", ["info", "--format", "{{.ServerVersion}}"], 8_000);
  const projects = await runner.listProjects(ctx.home).catch(() => []);
  const gwConfig = await readJsonFile(join(ctx.home, "gateway.json"));
  const pairing = await readJsonFile(join(ctx.home, "gateway", "pairing.json"));
  const last = await newestSession(ctx.home);
  const report = await runDoctor({ home: ctx.home, userHome: ctx.userHome, env: ctx.env, cwd: ctx.cwd, now: ctx.now, deep: opts.deep, runner, checks: opts.checks });

  return {
    version: ctx.version,
    channel: settings?.autoUpdatesChannel ?? "latest",
    autoUpdates: settings?.autoUpdates ?? true,
    install: {
      current: state?.current ?? null,
      previous: state?.previous ?? null,
      pending: state?.pending?.to ?? null,
      lastCheck: state?.autoUpdate.lastCheck ?? null,
      lastUpdated: state?.autoUpdate.lastUpdated ?? null,
      updateReady,
    },
    service,
    gateway: running && gw ? { running: true, pid: gw.pid, startedAt: gw.startedAt } : { running: false },
    web,
    providers,
    docker: docker.code === 0 ? { ok: true, detail: `server ${docker.stdout.trim()}` } : { ok: false, detail: docker.error?.includes("not found") ? "not installed" : "daemon not reachable" },
    projects: { count: projects.length, default: isRecord(gwConfig) && typeof gwConfig.defaultProject === "string" ? gwConfig.defaultProject : "default" },
    paired: isRecord(pairing) && Array.isArray(pairing.approved) ? pairing.approved.length : 0,
    lastSession: last === null ? null : new Date(last).toISOString(),
    cronJobs: await countJobs(ctx.home),
    doctor: {
      errors: report.summary.error,
      warnings: report.summary.warn,
      fixable: report.findings.filter((f) => f.fixable && f.level !== "ok").length,
    },
  };
}

function serviceLine(s: Status["service"]): string {
  if ("error" in s) return `unknown (${s.error})`;
  if (s.manager === "none") return "not available on this system";
  if (!s.installed) return `${s.manager}: not installed`;
  return `${s.manager}: installed, ${s.running ? `running${s.pid ? ` (pid ${s.pid})` : ""}` : "stopped"}`;
}

export function renderStatus(s: Status, all: boolean): string {
  const rows: Array<[string, string]> = [
    ["install", `${s.install.current ? `current ${s.install.current}` : "not managed by the installer"}${s.install.previous ? `, previous ${s.install.previous}` : ""}${s.install.pending ? `, switching to ${s.install.pending}` : ""}`],
    ["updates", `${s.autoUpdates ? "automatic" : "manual"}${s.install.updateReady ? `; ${s.install.updateReady} is installed, restart to use it` : ""}${s.install.lastCheck ? `; last checked ${s.install.lastCheck}` : ""}`],
    ["service", serviceLine(s.service)],
    ["gateway", s.gateway.running ? `running (pid ${s.gateway.pid}${s.gateway.startedAt ? `, since ${s.gateway.startedAt}` : ""})` : "not running"],
    ...(s.web ? ([["web", s.web.url + (all ? "" : "  (token hidden; --all shows it)")]] as Array<[string, string]>) : []),
    ["providers", s.providers.length ? s.providers.join(", ") : "none connected"],
    ["docker", `${s.docker.ok ? "ok" : "unavailable"} (${s.docker.detail})`],
    ["projects", `${s.projects.count} (default: ${s.projects.default})`],
    ["paired", `${s.paired} sender${s.paired === 1 ? "" : "s"}`],
    ["last session", s.lastSession ?? "none yet"],
    ...(s.cronJobs !== null ? ([["scheduled", `${s.cronJobs} job${s.cronJobs === 1 ? "" : "s"}`]] as Array<[string, string]>) : []),
    ["doctor", `${s.doctor.errors} error${s.doctor.errors === 1 ? "" : "s"}, ${s.doctor.warnings} warning${s.doctor.warnings === 1 ? "" : "s"}${s.doctor.fixable ? `, ${s.doctor.fixable} fixable` : ""}${s.doctor.errors + s.doctor.warnings ? " (run `tcode doctor`)" : ""}`],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return [`Tropos Code ${s.version} (channel ${s.channel})`, ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`)].join("\n") + "\n";
}

export async function runStatusCommand(argv: string[], ctx: LifecycleContext, deps: { runner?: Partial<Runner>; checks?: DoctorOptions["checks"] } = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.out(HELP);
    return 0;
  }
  const parsed = parseFlags(argv, { bool: ["json", "deep", "all"], value: [] });
  if (!parsed.ok || parsed.rest.length) {
    ctx.err(`tcode status: ${parsed.ok ? `unexpected argument ${parsed.rest[0]}` : parsed.error}\nRun \`tcode status --help\` for usage.\n`);
    return 64;
  }
  const all = parsed.bool.has("all");
  const status = await gatherStatus(ctx, { deep: parsed.bool.has("deep"), all, ...deps });
  ctx.out(parsed.bool.has("json") ? `${JSON.stringify(status, null, 2)}\n` : renderStatus(status, all));
  return 0;
}

const run: LifecycleRun = (argv, ctx) => runStatusCommand(argv, ctx);
export default run;
