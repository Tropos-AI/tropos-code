// src/cli/lifecycle/uninstall.ts — `tcode uninstall`: remove the service, the binary and (only if asked) the data (spec §2.3).
import { parseArgs } from "node:util";
import { resolveLayout } from "../../install/layout";
import { serviceManager } from "../../service";
import { SCOPES, executeSteps, planUninstall, type Scope, type UninstallDeps } from "../../uninstall";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode uninstall [--service] [--binary] [--data] [--all] [--keep-data] [--dry-run] [--yes] [--no-backup]

  --service    stop and remove the gateway service, leftover sandbox containers and gateway/state.json
  --binary     remove the tcode/tropos command links, installed versions, manifests, install state and logs,
               and the PATH block the installer added to shell startup files
  --data       delete ~/.tropos (settings, keys, memory, sessions, workspace); a backup is made first
  --all        all three scopes
  --keep-data  with --all: everything except --data
  --dry-run    print what would happen and change nothing
  --yes        do not ask; required without a terminal
  --no-backup  do not back up ~/.tropos before deleting it

With no scope on a terminal you are asked about each; the default is service + binary, never data.
`;

export function defaultDeps(ctx: LifecycleContext): UninstallDeps {
  return {
    env: ctx.env,
    home: ctx.home,
    userHome: ctx.userHome,
    layout: resolveLayout(ctx.env, ctx.userHome),
    service: serviceManager(),
    sweepContainers: async () => (await import("../../exec/docker")).sweepLeftoverContainers(),
    now: ctx.now,
    version: ctx.version,
  };
}

export function createUninstall(makeDeps: (ctx: LifecycleContext) => UninstallDeps = defaultDeps): LifecycleRun {
  return async (argv, ctx) => {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          service: { type: "boolean" },
          binary: { type: "boolean" },
          data: { type: "boolean" },
          all: { type: "boolean" },
          "keep-data": { type: "boolean" },
          "dry-run": { type: "boolean" },
          yes: { type: "boolean", short: "y" },
          "no-backup": { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (err) {
      ctx.err(`tcode uninstall: ${(err as Error).message}\n${HELP}`);
      return 64;
    }
    const v = parsed.values;
    if (v.help) {
      ctx.out(HELP);
      return 0;
    }
    if (parsed.positionals.length) {
      ctx.err(`tcode uninstall: unexpected argument "${parsed.positionals[0]}"\n`);
      return 64;
    }
    if (v.data && v["keep-data"]) {
      ctx.err("tcode uninstall: --data and --keep-data contradict each other\n");
      return 64;
    }
    const dryRun = v["dry-run"] ?? false;
    const explicit = new Set<Scope>();
    if (v.all) SCOPES.forEach((s) => explicit.add(s));
    if (v.service) explicit.add("service");
    if (v.binary) explicit.add("binary");
    if (v.data) explicit.add("data");
    if (v["keep-data"]) explicit.delete("data");
    const keepOnly = v["keep-data"] && explicit.size === 0;

    let scopes: Set<Scope>;
    if (explicit.size > 0) scopes = explicit;
    else if (keepOnly || dryRun || !ctx.interactive) scopes = new Set<Scope>(["service", "binary"]);
    else {
      scopes = new Set();
      if (await ctx.confirm("Stop and remove the gateway service?", true)) scopes.add("service");
      if (await ctx.confirm("Remove the tcode command, installed versions and PATH entry?", true)) scopes.add("binary");
      if (await ctx.confirm(`Delete your data in ${ctx.home} (settings, keys, memory, sessions)?`, false)) scopes.add("data");
      if (scopes.size === 0) {
        ctx.out("Nothing selected.\n");
        return 0;
      }
    }
    if (!dryRun && !v.yes && !ctx.interactive) {
      ctx.err("tcode uninstall: this removes files; pass --yes to run it without a terminal (or --dry-run to see the plan).\n");
      return 64;
    }

    const deps = makeDeps(ctx);
    const steps = await planUninstall(deps, { scopes, backup: !v["no-backup"] });
    ctx.out(`${dryRun ? "Plan (nothing will be changed)" : "Plan"}:\n${steps.map((s) => `  [${s.scope}] ${s.describe}`).join("\n")}\n`);
    if (!scopes.has("data")) ctx.out(`Your data in ${ctx.home} is kept.\n`);
    if (dryRun) return 0;
    if (!v.yes && !(await ctx.confirm("Go ahead?", false))) {
      ctx.out("Cancelled.\n");
      return 1;
    }

    const reports = await executeSteps(steps);
    let failed = 0;
    for (const { step, result } of reports) {
      if (result.status === "failed") failed++;
      ctx.out(`  ${result.status.padEnd(7)} [${step.scope}] ${step.describe}${result.detail ? ` — ${result.detail}` : ""}\n`);
    }
    if (failed > 0) {
      ctx.err(`tcode uninstall: ${failed} step${failed === 1 ? "" : "s"} failed; the others were done.\n`);
      return 1;
    }
    ctx.out("Uninstall finished. Open a new terminal so the PATH change takes effect.\n");
    return 0;
  };
}

export default createUninstall();
