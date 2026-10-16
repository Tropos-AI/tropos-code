// src/cli/lifecycle/dashboard.ts — `tcode dashboard`: open the web UI of the running gateway.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFlags } from "../../doctor/flags";
import { pidAlive, readStateFile } from "../../doctor/util";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode dashboard [options]

Opens the web dashboard of the running gateway in your browser.
If the gateway is not running, says how to start it.

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
  /** Runs `tcode web` in the foreground; resolves with its exit code. */
  startWeb?: () => Promise<number>;
}

async function defaultOpen(url: string): Promise<void> {
  // Loaded on demand: serve.ts pulls in the whole runtime.
  (await import("../../web/serve")).openInBrowser(url);
}

/** `tcode web` as a child on the same terminal, run the way `tcode` itself was started. */
function defaultStartWeb(ctx: LifecycleContext): () => Promise<number> {
  return () =>
    new Promise((resolve) => {
      const runtime = basename(ctx.execPath).toLowerCase();
      const argv = runtime === "bun" || runtime === "node" ? [ctx.scriptPath ?? "", "web"].filter(Boolean) : ["web"];
      const child = spawn(ctx.execPath, argv, { stdio: "inherit", env: ctx.env, cwd: ctx.cwd });
      child.once("error", () => resolve(1));
      child.once("close", (code) => resolve(code ?? 1));
    });
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
  const target = await runningDashboard(ctx.home, deps.alive);
  if (!target) {
    ctx.err("The gateway is not running, so there is no dashboard to open.\n");
    ctx.out("Start it with:\n  tcode gateway           run it in this terminal\n  tcode gateway install   keep it running in the background\n");
    if (!ctx.interactive) return 1;
    if (!(await ctx.confirm("Start the web UI now instead (tcode web, stops when you press ctrl+c)?", false))) return 1;
    return (deps.startWeb ?? defaultStartWeb(ctx))();
  }
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
