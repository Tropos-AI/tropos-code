// src/cli/lifecycle/harness.ts — `tcode harness`: the harness this project's sessions run with (src/harness/tree.ts),
// the lab that tests changes to it, and the candidates the lab leaves for adoption.
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { EFFORTS, type Effort } from "../../config/constants";
import { loadSettings, settingsPaths } from "../../config/settings";
import { BASE_TREE } from "../../harness/base";
import { adoptCandidate, candidateRunsCode, discardCandidate, layerDir, listCandidates, readCandidate, revertCandidate, type Candidate } from "../../harness/candidates";
import { DOMAINS, isDomain } from "../../harness/domain";
import { labDir, readLabRun } from "../../harness/lab";
import { libraryDir, listEntries } from "../../harness/library";
import { labOnTask, labTools, replayTasks, taskFromFile, taskFromPrompt } from "../../harness/service";
import { ALWAYS_ON_CHARS } from "../../harness/surface";
import { assembleSystem, diffTrees, loadHarness, readLayer, renderTreeDiff, type Harness } from "../../harness/tree";
import { Ledger } from "../../learning/ledger";
import { ProviderRouter } from "../../providers/router";
import { resolveToolPath } from "../../tools/paths";
import { readdir } from "node:fs/promises";
import type { LifecycleContext, LifecycleRun } from "./types";

const USAGE = `Usage: tcode harness [command] [--json]
  status                  Which layers apply in this folder, their files, the always-on budget and any problems (default)
  diff [<candidate>]      What the adopted layers change against the built-in harness, or what a candidate would change
  show [<file>]           One file of the harness in effect, or the whole system prompt
  lab [<task prompt>]     Test changes to the harness on a task in this project, and keep one that did better
      --replay <session> | --replay-recent <n> | --task-file <json>   where the task comes from instead of a prompt
      --k <n> --mode parallel|sequential   more compositions, picked by a selector, or chained steps (default 1, parallel)
      --scope global|project   which adopted layer a candidate is for (default global)
      --model <id> --editor-model <id> --effort <level>   the probes' model, the editors' model (default the same)
      --check <cmd>... --setup <cmd> --revision <rev> --max-turns <n> --timeout <minutes>
      --adopt                 adopt the candidate at once when it improved and adds no scripts
  candidates              Candidates waiting, adopted and reverted
  adopt <candidate> [--yes]   Write a candidate into its layer (through the ledger; scripts need --yes)
  revert [<candidate>]    Take back an adopted candidate (default: the last one)
  discard <candidate>     Drop a waiting candidate
  runs                    The lab's runs, newest first
  library [<domain>]      The lessons and harnesses the lab kept, by domain
Adopted layers live in ~/.tropos/harness/active (every project) and ~/.tropos/harness/projects/<key>/active (one).
`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

class UsageError extends Error {}

function status(harness: Harness, json: boolean, ctx: LifecycleContext): number {
  const chars = assembleSystem(harness.tree).length;
  const changes = diffTrees(BASE_TREE, harness.tree);
  if (json) {
    ctx.out(`${JSON.stringify({ layers: harness.layers, alwaysOnChars: chars, alwaysOnLimit: ALWAYS_ON_CHARS, changes })}\n`);
    return 0;
  }
  const lines = [`System prompt: ${chars} of ${ALWAYS_ON_CHARS} characters`, ""];
  for (const layer of harness.layers) {
    const where = layer.dir ? ` (${layer.dir})` : " (built in)";
    const state = !layer.applied ? "skipped" : layer.files.length === 0 ? "empty" : plural(layer.files.length, "file");
    lines.push(`${layer.name}${where}: ${state}`);
    for (const file of layer.files) lines.push(`  ${file}`);
    for (const problem of layer.problems) lines.push(`  ! ${problem}`);
  }
  lines.push("", changes.length === 0 ? "No changes against the built-in harness." : `${plural(changes.length, "change")} against the built-in harness: tcode harness diff`);
  ctx.out(`${lines.join("\n")}\n`);
  return 0;
}

function candidateLine(c: Candidate): string {
  const verdict = c.verdict ? `${c.verdict.outcome}${c.verdict.reasons[0] ? ` (${c.verdict.reasons[0]})` : ""}` : "untested";
  const files = Object.keys(c.changes).join(", ");
  return `${c.id}  ${c.status.padEnd(9)} ${c.source}  ${c.scope === "global" ? "every project" : basename(c.project ?? "")}  ${verdict}\n    ${c.task.title}: ${files}${candidateRunsCode(c) ? "  [adds scripts: owner only]" : ""}`;
}

/** What adopting the candidate would change in its layer, as a patch. */
async function candidateDiff(home: string, c: Candidate): Promise<string> {
  const layer = (await readLayer(layerDir(home, c))).tree;
  const next = new Map(layer);
  for (const [path, value] of Object.entries(c.changes)) {
    if (value === null) next.delete(path);
    else next.set(path, value);
  }
  return renderTreeDiff(layer, next);
}

async function lab(argv: string[], ctx: LifecycleContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      replay: { type: "string" },
      "replay-recent": { type: "string" },
      "task-file": { type: "string" },
      k: { type: "string" },
      mode: { type: "string" },
      scope: { type: "string" },
      model: { type: "string" },
      "editor-model": { type: "string" },
      effort: { type: "string" },
      check: { type: "string", multiple: true },
      setup: { type: "string" },
      revision: { type: "string" },
      "max-turns": { type: "string" },
      timeout: { type: "string" },
      adopt: { type: "boolean" },
    },
  });
  const count = (name: string, raw: string | undefined, fallback: number, max: number) => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`--${name} must be a whole number from 1 to ${max}`);
    return n;
  };
  const k = count("k", values.k, 1, 8);
  const mode = values.mode ?? "parallel";
  if (mode !== "parallel" && mode !== "sequential") throw new UsageError("--mode must be parallel or sequential");
  const scope = values.scope ?? "global";
  if (scope !== "global" && scope !== "project") throw new UsageError("--scope must be global or project");
  if (values.effort !== undefined && !(EFFORTS as readonly string[]).includes(values.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}`);
  const sources = [positionals.length > 0, values.replay !== undefined, values["replay-recent"] !== undefined, values["task-file"] !== undefined].filter(Boolean).length;
  if (sources !== 1) throw new UsageError("give exactly one task: a prompt, --replay, --replay-recent or --task-file");

  const cwd = resolveToolPath(".", ctx.cwd);
  const { settings } = await loadSettings(settingsPaths(cwd, ctx.home));
  const env = { ...ctx.env, ...settings.env };
  const taskOpts = { ...(values.revision ? { revision: values.revision } : {}), ...(values.setup ? { setup: values.setup } : {}), ...(values.check ? { checks: values.check } : {}) };
  const tasks = values["task-file"]
    ? [await taskFromFile(resolveToolPath(values["task-file"], cwd), cwd)]
    : values.replay || values["replay-recent"]
      ? await replayTasks(ctx.home, cwd, { ...(values.replay ? { session: values.replay } : { recent: count("replay-recent", values["replay-recent"], 3, 20) }), ...taskOpts })
      : [await taskFromPrompt(cwd, positionals.join(" "), taskOpts)];
  if (tasks.length === 0) {
    ctx.err("tcode harness lab: no past sessions here to replay.\n");
    return 1;
  }
  const model = values.model ?? settings.model;
  const runtime = basename(ctx.execPath).toLowerCase();
  const command = (runtime === "bun" || runtime === "node") && ctx.scriptPath ? [ctx.execPath, ctx.scriptPath] : [ctx.execPath];
  const { runner, llm } = await labTools({
    home: ctx.home,
    env,
    command,
    router: new ProviderRouter({ home: ctx.home, env, settings: settings.providers }),
    providers: settings.providers as Record<string, unknown>,
    models: { model, effort: (values.effort as Effort | undefined) ?? settings.effort, ...(values["editor-model"] ? { editorModel: values["editor-model"] } : {}) },
    maxTurns: count("max-turns", values["max-turns"], 60, 500),
    timeoutMs: count("timeout", values.timeout, 30, 240) * 60_000,
  });
  const ledger = new Ledger(ctx.home);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  let failed = 0;
  try {
    for (const task of tasks) {
      ctx.out(`\nLab on "${task.title}" (${task.domain}, ${task.checks.length ? task.checks.join("; ") : "no checks"}), k=${k} ${mode}, model ${model}\n`);
      const r = await labOnTask(task, { home: ctx.home, runner, llm, model, scope, k, mode, autoAdopt: values.adopt ?? false, ledger, signal: controller.signal, log: (line) => ctx.out(`  ${line}\n`) });
      const cost = r.run.costUsd === null ? "cost unknown" : `$${r.run.costUsd.toFixed(2)}`;
      ctx.out(`Verdict: ${r.run.verdict.outcome}${r.run.verdict.reasons.length ? `: ${r.run.verdict.reasons.join("; ")}` : ""} (${cost})\n`);
      if (r.reflection.stored) ctx.out(`Library: ${plural(r.reflection.lessons.length, "lesson")} kept for ${task.domain}\n`);
      if (r.adopted) ctx.out(`Adopted candidate ${r.adopted.id}. Undo: tcode harness revert ${r.adopted.id}\n`);
      else if (r.run.candidate) ctx.out(`Candidate ${r.run.candidate} is waiting${r.pending ? ` (${r.pending})` : ""}: tcode harness diff ${r.run.candidate}, then tcode harness adopt ${r.run.candidate}\n`);
      if (r.run.verdict.outcome === "invalid") failed++;
      if (controller.signal.aborted) break;
    }
  } finally {
    process.removeListener("SIGINT", stop);
  }
  return failed > 0 && failed === tasks.length ? 1 : 0;
}

const run: LifecycleRun = async (argv, ctx) => {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const [command = "status", ...rest] = args;
  if (command === "-h" || command === "--help" || command === "help") {
    ctx.out(USAGE);
    return 0;
  }
  try {
    if (command === "lab") return await lab(rest, ctx);
    const cwd = resolveToolPath(".", ctx.cwd);
    if (command === "status" && rest.length === 0) return status(await loadHarness({ home: ctx.home, cwd }), json, ctx);
    if (command === "diff" && rest.length <= 1 && !json) {
      if (rest[0]) {
        const c = await readCandidate(ctx.home, rest[0]);
        if (!c) throw new UsageError(`no candidate ${rest[0]}`);
        ctx.out((await candidateDiff(ctx.home, c)) || "The candidate changes nothing in its layer any more.\n");
        return 0;
      }
      const harness = await loadHarness({ home: ctx.home, cwd });
      ctx.out(renderTreeDiff(BASE_TREE, harness.tree) || "No changes against the built-in harness.\n");
      return 0;
    }
    if (command === "show" && rest.length <= 1 && !json) {
      const harness = await loadHarness({ home: ctx.home, cwd });
      const [file] = rest;
      if (file === undefined) {
        ctx.out(`${harness.system}\n`);
        return 0;
      }
      const text = harness.tree.get(file);
      if (text === undefined) {
        ctx.err(`tcode harness: no ${file} in the harness here. Files: ${[...harness.tree.keys()].sort().join(", ")}\n`);
        return 1;
      }
      ctx.out(text.endsWith("\n") ? text : `${text}\n`);
      return 0;
    }
    if (command === "candidates" && rest.length === 0) {
      const all = await listCandidates(ctx.home);
      if (json) ctx.out(`${JSON.stringify(all)}\n`);
      else ctx.out(all.length ? `${all.map(candidateLine).join("\n")}\n` : "No candidates yet. Run tcode harness lab.\n");
      return 0;
    }
    if (command === "adopt" && (rest.length === 1 || (rest.length === 2 && rest.includes("--yes")))) {
      const id = rest.find((a) => a !== "--yes")!;
      const c = await readCandidate(ctx.home, id);
      if (!c) throw new UsageError(`no candidate ${id}`);
      let allowCode = rest.includes("--yes");
      if (candidateRunsCode(c) && !allowCode && ctx.interactive) {
        ctx.out(await candidateDiff(ctx.home, c));
        allowCode = await ctx.confirm("This candidate adds scripts the agent will run. Adopt it?", false);
      }
      const r = await adoptCandidate(ctx.home, id, { ledger: new Ledger(ctx.home), actor: "user", allowCode });
      if (!r.ok) {
        ctx.err(`tcode harness: ${r.reason}${candidateRunsCode(c) && !allowCode ? " Add --yes to adopt it." : ""}\n`);
        return 1;
      }
      ctx.out(`Adopted ${id} into ${layerDir(ctx.home, c)}. New sessions use it; undo with tcode harness revert ${id}.\n`);
      return 0;
    }
    if (command === "revert" && rest.length <= 1) {
      const id = rest[0] ?? (await listCandidates(ctx.home)).filter((c) => c.status === "adopted").sort((a, b) => (b.adoptedAt ?? "").localeCompare(a.adoptedAt ?? ""))[0]?.id;
      if (!id) throw new UsageError("nothing adopted to revert");
      const r = await revertCandidate(ctx.home, id, new Ledger(ctx.home));
      if (!r.ok) {
        ctx.err(`tcode harness: ${r.reason}\n`);
        return 1;
      }
      ctx.out(`Reverted ${id}.\n`);
      return 0;
    }
    if (command === "discard" && rest.length === 1) {
      const r = await discardCandidate(ctx.home, rest[0]!);
      if (!r.ok) {
        ctx.err(`tcode harness: ${r.reason}\n`);
        return 1;
      }
      ctx.out(`Discarded ${rest[0]}.\n`);
      return 0;
    }
    if (command === "runs" && rest.length === 0) {
      const ids = (await readdir(labDir(ctx.home)).catch(() => [] as string[])).sort().reverse();
      const runs = (await Promise.all(ids.map((id) => readLabRun(ctx.home, id)))).filter((r) => r !== null);
      if (json) ctx.out(`${JSON.stringify(runs)}\n`);
      else
        ctx.out(
          runs.length
            ? `${runs.map((r) => `${r.id}  ${r.verdict.outcome.padEnd(7)} ${r.task.title}  (${r.probes.length} runs, ${r.costUsd === null ? "cost unknown" : `$${r.costUsd.toFixed(2)}`})${r.candidate ? `  candidate ${r.candidate}` : ""}`).join("\n")}\n`
            : "No lab runs yet.\n",
        );
      return 0;
    }
    if (command === "library" && rest.length <= 1) {
      const domains = rest[0] ? [rest[0]] : [...DOMAINS];
      const lines: string[] = [];
      for (const domain of domains) {
        if (!isDomain(domain)) throw new UsageError(`unknown domain ${domain}; one of ${DOMAINS.join(", ")}`);
        const entries = await listEntries(ctx.home, domain);
        if (entries.length === 0 && !rest[0]) continue;
        lines.push(`${domain} (${libraryDir(ctx.home, domain)}): ${plural(entries.length, "entry")}`);
        for (const e of entries) lines.push(`  ${e.id}  ${e.outcome.padEnd(7)} ${e.task.title}  ${plural(e.lessons, "lesson")}${e.files.length ? `  harness: ${e.files.join(", ")}` : ""}`);
      }
      ctx.out(lines.length ? `${lines.join("\n")}\n` : "The library is empty. Lab runs fill it.\n");
      return 0;
    }
  } catch (err) {
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      ctx.err(`tcode harness: ${(err as Error).message}\n${USAGE}`);
      return 64;
    }
    ctx.err(`tcode harness: ${(err as Error).message}\n`);
    return 1;
  }
  ctx.err(USAGE);
  return 64;
};

export default run;
