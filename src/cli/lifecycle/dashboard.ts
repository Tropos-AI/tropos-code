// src/cli/lifecycle/dashboard.ts — `tcode dashboard`: open the web UI of the running gateway, logged in.
import { parseFlags } from "../../doctor/flags";
import { pidAlive, readStateFile, type GatewayStateFile } from "../../doctor/util";
import type { ServiceManager } from "../../service/types";
import { dashboardLoginLink, localDashboardUrl } from "../../web/links";
import { CODE_TTL_MS, ONE_TIME_TTL_MS, loginCodesFor } from "../../web/login-codes";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode dashboard [options]

Opens the web dashboard of the gateway in your browser. If the background service is stopped,
starts it; if it is not installed, offers to install it.

The link it opens logs this browser in once; after that the browser stays logged in and never
needs a link again. Other browsers and your phone log in with a 6-digit code (--code).

Options:
  --code        print a 6-digit code to log in another browser or your phone (works once, for 10 minutes)
  --print-url   print the one-time login link instead of opening it (works once, for 2 minutes)
  --no-open     only print where the dashboard is
  --help        show this text
`;

export interface DashboardTarget {
  /** http://localhost:<port>/ */
  url: string;
  port: number;
}

/** The running gateway's web UI (state.json names a live pid and a web port), or null. */
export async function runningDashboard(home: string, alive: (pid: number) => boolean = pidAlive): Promise<DashboardTarget | null> {
  const state = await readStateFile(home);
  if (!state || !alive(state.pid) || !state.webPort) return null;
  return { url: localDashboardUrl(state.webPort), port: state.webPort };
}

export interface DashboardDeps {
  alive?: (pid: number) => boolean;
  openBrowser?: (url: string) => void | Promise<void>;
  /** The background service manager (default: this system's). */
  service?: ServiceManager;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a started service to publish its port (default 15 000). */
  waitMs?: number;
  /** Test seam for the default project's `git init` when installing the service. */
  git?: (dir: string) => Promise<void>;
}

const POLL_MS = 250;

/** Polls state.json until a live gateway has a dashboard port or says why it has none; null when `waitMs` runs out. */
export async function waitForDashboard(
  home: string,
  o: { alive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void>; waitMs: number },
): Promise<GatewayStateFile | null> {
  const alive = o.alive ?? pidAlive;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Counted in polls, not wall-clock time, so a fake sleep finishes at once.
  for (let waited = 0; ; waited += POLL_MS) {
    const state = await readStateFile(home);
    if (state && alive(state.pid) && (state.webPort || state.webProblem)) return state;
    if (waited >= o.waitMs) return null;
    await sleep(POLL_MS);
  }
}

async function defaultOpen(url: string): Promise<void> {
  // Loaded on demand: serve.ts is small, but the CLI only needs it here.
  (await import("../../web/serve")).openInBrowser(url);
}

/** Brings the background service up (installing it when the owner agrees) and waits for the dashboard. Null: nothing to open, already explained. */
async function startDashboard(ctx: LifecycleContext, deps: DashboardDeps): Promise<DashboardTarget | null> {
  const service =
    deps.service ?? (await import("../../service")).serviceManager({ platform: process.platform, userHome: ctx.userHome });
  const status = await service.status().catch(() => ({ manager: "none" as const, installed: false, running: false }));
  if (status.manager === "none") {
    ctx.err("The gateway is not running, and this system has no background service for it.\n");
    ctx.out("Run `tcode gateway` in another terminal, then try again.\n");
    return null;
  }
  if (!status.installed) {
    ctx.err("The gateway is not running, so there is no dashboard to open yet.\n");
    if (!ctx.interactive) {
      ctx.out("Install the background service with:\n  tcode gateway install\n");
      return null;
    }
    if (!(await ctx.confirm("Install the background service now? It keeps the dashboard and your chats running.", true))) return null;
    const { installService } = await import("../../gateway/commands");
    await installService({ home: ctx.home, env: ctx.env, execPath: ctx.execPath, scriptPath: ctx.scriptPath, userHome: ctx.userHome, service, git: deps.git });
  } else if (!status.running) {
    await service.start();
  }
  const state = await waitForDashboard(ctx.home, { alive: deps.alive, sleep: deps.sleep, waitMs: deps.waitMs ?? 15_000 });
  if (!state) {
    ctx.err("The service didn't start the dashboard; see `tcode logs gateway`.\n");
    return null;
  }
  if (state.webProblem) {
    ctx.err(`The dashboard is off: ${state.webProblem}\n`);
    return null;
  }
  return runningDashboard(ctx.home, deps.alive);
}

export async function runDashboard(argv: string[], ctx: LifecycleContext, deps: DashboardDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.out(HELP);
    return 0;
  }
  const parsed = parseFlags(argv, { bool: ["no-open", "print-url", "code"], value: [] });
  if (!parsed.ok || parsed.rest.length) {
    ctx.err(`tcode dashboard: ${parsed.ok ? `unexpected argument ${parsed.rest[0]}` : parsed.error}\nRun \`tcode dashboard --help\` for usage.\n`);
    return 64;
  }
  const target = (await runningDashboard(ctx.home, deps.alive)) ?? (await startDashboard(ctx, deps));
  if (!target) return 1;
  if (parsed.bool.has("code")) {
    const code = await loginCodesFor(ctx.home).issueCode();
    ctx.out(`Code: ${code.slice(0, 3)} ${code.slice(3)} (works once, for ${CODE_TTL_MS / 60_000} minutes)\nType it on the login screen at ${target.url}\n`);
    return 0;
  }
  if (parsed.bool.has("print-url")) {
    ctx.out(`${await dashboardLoginLink(ctx.home, target.port)}\n`);
    ctx.err(`This link logs in whoever opens it first. It works once, for ${ONE_TIME_TTL_MS / 60_000} minutes; do not share it.\n`);
    return 0;
  }
  if (parsed.bool.has("no-open")) {
    ctx.out(`The dashboard is at ${target.url}\nTo log in from another browser or your phone, run: tcode dashboard --code\n`);
    return 0;
  }
  ctx.out(`Opening the dashboard at ${target.url}\n`);
  await (deps.openBrowser ?? defaultOpen)(await dashboardLoginLink(ctx.home, target.port));
  return 0;
}

const run: LifecycleRun = (argv, ctx) => runDashboard(argv, ctx);
export default run;
