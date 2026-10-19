// src/cli/lifecycle/migrate.ts — `tcode migrate openclaw|hermes|list`: the CLI over src/migrate.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CATEGORIES, MigrateError, SOURCE_IDS, detectSources, executePlan, hasWrites, planMigration, publicPlan, type Category, type SkillConflict, type SourceId } from "../../migrate";
import { layoutAtStart } from "../../home/migrate";
import { renderPlan, renderResult, renderSources } from "../../migrate/render";
import type { LifecycleRun } from "./types";

const HELP = `Usage: tcode migrate <openclaw|hermes> [options]
       tcode migrate list

Brings identity, memory and skills from OpenClaw or Hermes into Tropos. The source is only read.

  --source <dir>            the tool's directory (default: $OPENCLAW_STATE_DIR / ~/.openclaw / ~/.clawdbot / ~/.moltbot,
                            or $HERMES_HOME / ~/.hermes)
  --dry-run                 print the full plan and change nothing
  --yes                     do not ask (required without a terminal)
  --only <list>             comma-separated: ${CATEGORIES.join(", ")}
  --skill-conflict <mode>   overwrite | skip | rename (default rename: an "-imported" suffix)
  --migrate-secrets         also copy provider API keys for providers Tropos knows (never printed)
  --allow-flagged           import skills the threat scanner flags (they still load as [blocked] text)
  --allow-scripts           keep the executable bit on imported skill files (default: files are private and not executable)
  --no-backup               skip the safety backup of ~/.tropos made before writing
  --json                    machine-readable output
  list                      show installed sources and what could be imported

SOUL.md, AGENTS.md, memory notes and skills become instructions the agent follows in every session: the plan lists
each file with its size and the start of its content, and asks before importing.

Channel tokens are never imported. The model choice is only suggested. Re-running skips what is unchanged.
`;

const run: LifecycleRun = async (argv, ctx) => {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        source: { type: "string" },
        "dry-run": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        only: { type: "string" },
        "skill-conflict": { type: "string" },
        "migrate-secrets": { type: "boolean" },
        "allow-flagged": { type: "boolean" },
        "allow-scripts": { type: "boolean" },
        "no-backup": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    ctx.err(`tcode migrate: ${(err as Error).message}\n${HELP}`);
    return 64;
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    ctx.out(HELP);
    return 0;
  }
  const usage = (msg: string) => {
    ctx.err(`tcode migrate: ${msg}\n`);
    return 64;
  };
  const [what, ...extra] = positionals;
  if (!what) {
    ctx.err(HELP);
    return 64;
  }
  if (extra.length) return usage(`unexpected argument ${extra[0]}`);
  const deps = { home: ctx.home, userHome: ctx.userHome, env: ctx.env, now: ctx.now, version: ctx.version };

  if (what === "list") {
    const list = await detectSources(deps);
    ctx.out(v.json ? `${JSON.stringify(list, null, 2)}\n` : renderSources(list));
    return 0;
  }
  if (!SOURCE_IDS.includes(what as SourceId)) return usage(`unknown source "${what}" (use openclaw, hermes or list)`);
  const only = v.only ? v.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  if (only?.some((c) => !CATEGORIES.includes(c as Category))) return usage(`--only takes ${CATEGORIES.join(", ")}`);
  const conflict = v["skill-conflict"] ?? "rename";
  if (!["overwrite", "skip", "rename"].includes(conflict)) return usage("--skill-conflict takes overwrite, skip or rename");
  const dryRun = v["dry-run"] ?? false;
  if (!dryRun && !v.yes && !ctx.interactive) return usage("without a terminal, pass --yes to import or --dry-run to see the plan");

  try {
    const planOptions = {
      source: what as SourceId,
      sourceDir: v.source ? resolve(ctx.cwd, v.source) : undefined,
      only: only as Category[] | undefined,
      skillConflict: conflict as SkillConflict,
      migrateSecrets: v["migrate-secrets"] ?? false,
      allowFlagged: v["allow-flagged"] ?? false,
      allowScripts: v["allow-scripts"] ?? false,
    };
    let plan = await planMigration(planOptions, deps);
    if (dryRun || !hasWrites(plan)) {
      ctx.out(v.json ? `${JSON.stringify({ dryRun, ...publicPlan(plan) }, null, 2)}\n` : renderPlan(plan, dryRun));
      return 0;
    }
    if (!v.json) ctx.out(renderPlan(plan, false));
    if (!v.yes && !(await ctx.confirm("Import these? SOUL.md, AGENTS.md, memory and skills become instructions the agent follows in every session.", false))) {
      ctx.out("Cancelled.\n");
      return 1;
    }
    // The imports land in the workspace: lay an old home out first (it makes its own backup), then plan again on the new layout.
    const laid = await layoutAtStart(ctx.home, ctx.version, ctx.err, ctx.now);
    if (laid?.ran) plan = await planMigration(planOptions, deps);
    const result = await executePlan(plan, deps, { backup: !v["no-backup"], onProgress: (m) => ctx.err(`${m}\n`) });
    ctx.out(v.json ? `${JSON.stringify({ ...publicPlan(plan), result }, null, 2)}\n` : renderResult(result));
    return result.failed.length ? 1 : 0;
  } catch (err) {
    if (err instanceof MigrateError) {
      ctx.err(`tcode migrate: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
};
export default run;
