// src/cli/lifecycle/dashboard.ts — `tcode dashboard`: open the web UI of the running gateway.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFlags } from "../../doctor/flags";
import { pidAlive, readStateFile, type GatewayStateFile } from "../../doctor/util";
import type { ServiceManager } from "../../service/types";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode dashboard [options]

Opens the web dashboard of the gateway in your browser. If the background service is stopped,
starts it; if it is not installed, offers to install it.

Options:
  --no-open     do not open a browser
  --print-url   print the link (it contains a secret key: do not share it)
  --help        show this text
`;

export interface DashboardTarget {
  /** The link without the key. */
  url: string;
  /** The link with the persistent key, or null when the gateway has no token file yet. */
  secretUrl: string | null;
}

/** The running gateway's web UI (state.json names a live pid and a web port), or null. */
export async function runningDashboard(home: string, alive: (pid: number) => boolean = pidAlive): Promise<DashboardTarget | null> {
  const state = await readStateFile(home);
  if (!state || !alive(state.pid) || !state.webPort) return null;
  const url = `http://127.0.0.1:${state.webPort}/`;
  const token = (await readFile(join(home, "gateway", "token"), "utf8").catch(() => "")).trim();
  return { url, secretUrl: token ? `${url}?token=${token}` : null };
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
  const parsed = parseFlags(argv, { bool: ["no-open", "print-url"], value: [] });
  if (!parsed.ok || parsed.rest.length) {
    ctx.err(`tcode dashboard: ${parsed.ok ? `unexpected argument ${parsed.rest[0]}` : parsed.error}\nRun \`tcode dashboard --help\` for usage.\n`);
    return 64;
  }
  const target = (await runningDashboard(ctx.home, deps.alive)) ?? (await startDashboard(ctx, deps));
  if (!target) return 1;
  if (parsed.bool.has("print-url")) {
    if (!target.secretUrl) {
      ctx.err("The gateway has no web key yet; restart it (tcode gateway restart) and try again.\n");
      return 1;
    }
    ctx.out(`${target.secretUrl}\n`);
    ctx.err("This link contains a secret key that gives full access to your Tropos; do not share it.\n");
    return 0;
  }
  if (parsed.bool.has("no-open")) {
    ctx.out(`The dashboard is at ${target.url}\nUse --print-url for the link with the key.\n`);
    return 0;
  }
  if (!target.secretUrl) {
    ctx.err(`The gateway has no web key yet, so the link would not sign you in. Restart it (tcode gateway restart); the page is ${target.url}\n`);
    return 1;
  }
  ctx.out(`Opening the dashboard at ${target.url}\n`);
  await (deps.openBrowser ?? defaultOpen)(target.secretUrl);
  return 0;
}

const run: LifecycleRun = (argv, ctx) => runDashboard(argv, ctx);
export default run;
