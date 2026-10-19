// src/cli/lifecycle/reset.ts — `tcode reset`: put ~/.tropos back to a chosen earlier state, like openclaw's reset --scope.
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BackupError, createBackup, gatewayRunning } from "../../backup";
import { serviceManager } from "../../service";
import type { ServiceManager } from "../../service/types";
import { dataDirProblem } from "../../uninstall";
import type { LifecycleContext, LifecycleRun } from "./types";

export const RESET_SCOPES = ["config", "config+creds+sessions", "full"] as const;
export type ResetScope = (typeof RESET_SCOPES)[number];

const HELP = `Usage: tcode reset [--scope config|config+creds+sessions|full] [--dry-run] [--yes] [--no-backup]

  config                   settings.json and gateway.json only
  config+creds+sessions    (default) also credentials.json, gateway pairing, sessions and chats, history
  full                     everything in ~/.tropos including the workspace (older backups are kept)

A backup is made first (and its path printed) unless --no-backup. For the last two scopes the gateway
service is stopped first. Without a terminal, --yes is required.
`;

/** Paths below the home (files or directories) that a scope removes; `full` is computed from the directory listing. */
const CONFIG = ["settings.json", "gateway.json"];
const MIDDLE = [...CONFIG, "credentials.json", "gateway/pairing.json", "gateway/sessions.json", "gateway/chats.json", "history.jsonl"];

export async function resetTargets(home: string, scope: ResetScope): Promise<string[]> {
  if (scope === "config") return CONFIG.map((p) => join(home, p));
  if (scope === "config+creds+sessions") {
    // Sessions live in projects/<key>/; that directory's settings.json is configuration and stays.
    const sessions: string[] = [];
    for (const key of await readdir(join(home, "projects")).catch(() => [] as string[])) {
      for (const name of await readdir(join(home, "projects", key)).catch(() => [] as string[])) if (name !== "settings.json") sessions.push(join(home, "projects", key, name));
    }
    return [...MIDDLE.map((p) => join(home, p)), ...sessions];
  }
  const names = await readdir(home).catch(() => [] as string[]);
  // Earlier backups are the way back from a reset; they stay.
  return names.filter((n) => n !== "backups").sort().map((n) => join(home, n));
}

export interface ResetDeps {
  service: ServiceManager;
}

export function createReset(makeDeps: (ctx: LifecycleContext) => ResetDeps = () => ({ service: serviceManager() })): LifecycleRun {
  return async (argv, ctx) => {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { scope: { type: "string" }, "dry-run": { type: "boolean" }, yes: { type: "boolean", short: "y" }, "no-backup": { type: "boolean" }, help: { type: "boolean", short: "h" } },
      });
    } catch (err) {
      ctx.err(`tcode reset: ${(err as Error).message}\n${HELP}`);
      return 64;
    }
    const v = parsed.values;
    if (v.help) {
      ctx.out(HELP);
      return 0;
    }
    if (parsed.positionals.length) {
      ctx.err(`tcode reset: unexpected argument "${parsed.positionals[0]}"\n`);
      return 64;
    }
    const scope = (v.scope ?? "config+creds+sessions") as ResetScope;
    if (!RESET_SCOPES.includes(scope)) {
      ctx.err(`tcode reset: --scope must be one of ${RESET_SCOPES.join(", ")}\n`);
      return 64;
    }
    const dryRun = v["dry-run"] ?? false;
    if (!dryRun && !v.yes && !ctx.interactive) {
      ctx.err("tcode reset: this deletes files; pass --yes to run it without a terminal (or --dry-run to see what it would do).\n");
      return 64;
    }

    const full = scope === "full";
    // Every scope deletes by file name inside the home, so a TROPOS_HOME that points at ~ (say, from a project's .envrc)
    // must not get as far as `rm ~/settings.json`.
    const problem = await dataDirProblem({ home: ctx.home, userHome: ctx.userHome, explicit: Boolean(ctx.env.TROPOS_HOME) });
    if (problem) {
      ctx.err(`tcode reset: refusing to reset (scope ${scope}): ${problem}\n`);
      return 1;
    }
    const existing: string[] = [];
    for (const p of await resetTargets(ctx.home, scope)) if (await lstat(p).then(() => true, () => false)) existing.push(p);
    const stops = scope !== "config";
    const backup = !v["no-backup"];
    // A full reset empties the home, so its backup must live outside it; the others keep theirs in ~/.tropos/backups.
    const backupDir = full ? ctx.userHome : join(ctx.home, "backups");

    ctx.out(`${dryRun ? "Plan (nothing will be changed)" : "Plan"} for scope ${scope}:\n`);
    ctx.out(backup ? `  back up ${ctx.home} to ${backupDir}${full ? " (including the workspace)" : ""}\n` : "  no backup (--no-backup)\n");
    if (stops) ctx.out("  stop the gateway service\n");
    if (existing.length === 0) ctx.out("  nothing to delete: no matching files\n");
    for (const p of existing) ctx.out(`  delete ${p}\n`);
    if (dryRun) return 0;
    if (!v.yes && !(await ctx.confirm(`Reset ${ctx.home} (${scope})?`, false))) {
      ctx.out("Cancelled.\n");
      return 1;
    }

    if (backup) {
      try {
        const r = await createBackup({ home: ctx.home, now: ctx.now, output: backupDir, workspace: full, verify: true, troposVersion: ctx.version });
        ctx.out(`Backup: ${r.archive}\n`);
      } catch (err) {
        if (!(err instanceof BackupError && err.code === "empty")) {
          ctx.err(`tcode reset: the backup failed, so nothing was deleted: ${(err as Error).message}\n`);
          return 1;
        }
        ctx.out("Nothing to back up.\n");
      }
    }

    if (stops) {
      const { service } = makeDeps(ctx);
      try {
        const st = await service.status();
        if (st.running) {
          await service.stop();
          ctx.out("Gateway service stopped.\n");
        }
      } catch (err) {
        ctx.err(`tcode reset: could not stop the gateway service, so nothing was deleted: ${(err as Error).message}\n`);
        return 1;
      }
      if (await gatewayRunning(ctx.home)) {
        ctx.err("tcode reset: a gateway process is still running (not under the service manager). Stop it (Ctrl-C in its terminal, or kill the pid in gateway/state.json) and run reset again.\n");
        return 1;
      }
    }

    let failed = 0;
    for (const p of existing) {
      try {
        await rm(p, { recursive: true, force: true });
        ctx.out(`deleted ${p}\n`);
      } catch (err) {
        failed++;
        ctx.err(`tcode reset: could not delete ${p}: ${(err as Error).message}\n`);
      }
    }
    if (failed) return 1;
    ctx.out("Reset done.\nNext: tcode onboard\n");
    return 0;
  };
}

export default createReset();
