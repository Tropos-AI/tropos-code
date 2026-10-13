// scripts/eval.ts — the private-task scoreboard. See eval/README.md.
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGENTS, type AgentAdapter } from "../eval/lib/agents";
import { buildImage, engineArch } from "../eval/lib/docker";
import { readHarborJob } from "../eval/lib/harbor";
import { renderMarkdown } from "../eval/lib/report";
import { runTrial, validateTask, type TrialResult } from "../eval/lib/runner";
import { loadTasks, selectTasks, type Task } from "../eval/lib/task";
import { TEST_FILE, taskRepo } from "../eval/lib/workspace";
import { runKey } from "../eval/lib/keys";
import { readCredentials } from "../src/providers/credentials";
import { troposHome } from "../src/paths";

const ROOT = resolve(import.meta.dir, "..");
const TASKS = join(ROOT, "eval", "tasks");
const RESULTS = join(ROOT, "eval", "results");
const CLAUDE_CODE_VERSION = "2.1.296";
const IMAGE = `tcode-eval:cc-${CLAUDE_CODE_VERSION}`;
const HARBOR = "harbor==0.24.0";
const TB_DATASET = "terminal-bench@2.0";
/** Our agent names → harbor's -a values. */
const TB_AGENTS: Record<string, string> = { tropos: "tropos_agent:TroposAgent", claude: "claude-code" };

const USAGE = `Usage:
  bun scripts/eval.ts validate [--task <id>]... [--split dev|holdout]
      Check every task fails at its base commit and passes at its fix. No API calls.
  bun scripts/eval.ts run --agents tropos,claude [--task <id>]... [--split dev|holdout]
                          [--attempts 1] [--model claude-opus-5-5] [--effort high] [--concurrency 2]
      Run agents on tasks in Docker. Needs the model's API key (env var or /providers). Spends API money.
      Other providers: --agents tropos --model deepseek/deepseek-chat
  bun scripts/eval.ts tb --agents tropos,claude [--task <name>]... [--limit <n>]
                         [--attempts 1] [--model claude-opus-5-5] [--effort high] [--concurrency 4]
      Run Terminal-Bench 2.0 through harbor (uvx, Docker). Needs the model's API key. Spends API money.
  bun scripts/eval.ts report <results.jsonl>...
      Print the scoreboard for earlier runs.
  bun scripts/eval.ts new-task --from-commit <sha> --id <id> [--repo <path>] [--split dev|holdout]
      Scaffold a task from a fix commit: base = its parent, hidden tests = the test files it changed.
`;

function sh(cmd: string[], cwd = ROOT): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** Identifies what was measured: date, the commit tropos was built from, and whether the tree was dirty. */
function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const sha = sh(["git", "rev-parse", "--short", "HEAD"]);
  const dirty = sh(["git", "status", "--porcelain", "--", "src"]) ? "-dirty" : "";
  return `${stamp}-${sha}${dirty}`.toLowerCase();
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function prepareImage(): Promise<void> {
  console.error(`building ${IMAGE} …`);
  await buildImage(IMAGE, join(ROOT, "eval", "docker"), { CLAUDE_CODE_VERSION });
}

async function pickTasks(values: { task?: string[]; split?: string }): Promise<Task[]> {
  const split = values.split as Task["split"] | undefined;
  if (split && split !== "dev" && split !== "holdout") throw new Error(`--split must be dev or holdout`);
  return selectTasks(await loadTasks(TASKS), { ids: values.task, split });
}

async function validate(values: { task?: string[]; split?: string }): Promise<number> {
  const tasks = await pickTasks(values);
  if (tasks.length === 0) throw new Error("no tasks to validate");
  await prepareImage();
  const runId = newRunId();
  const scratch = join(tmpdir(), "tcode-eval", runId);
  let bad = 0;
  await pool(tasks, 3, async (task) => {
    try {
      const v = await validateTask(task, { image: IMAGE, harnessRoot: ROOT, scratch, runId });
      const ok = v.failsAtBase && v.passesAtGold;
      if (!ok) bad++;
      console.log(`${ok ? "ok  " : "BAD "} ${task.id}  fails at base: ${v.failsAtBase}  passes at fix: ${v.passesAtGold}`);
      if (!v.passesAtGold) console.log(`     fix output:\n${v.goldTail.replace(/^/gm, "       ")}`);
      if (!v.failsAtBase) console.log("     the hidden tests already pass without the fix: the task tests nothing");
    } catch (e) {
      bad++;
      console.log(`BAD  ${task.id}  ${(e as Error).message}`);
    }
  });
  console.log(`\n${tasks.length - bad}/${tasks.length} tasks valid`);
  return bad === 0 ? 0 : 1;
}

async function run(values: { task?: string[]; split?: string; agents?: string; attempts?: string; model?: string; effort?: string; concurrency?: string }): Promise<number> {
  const names = (values.agents ?? "").split(",").filter(Boolean);
  const agents: AgentAdapter[] = names.map((n) => {
    const agent = AGENTS[n];
    if (!agent) throw new Error(`unknown agent "${n}"; one of ${Object.keys(AGENTS).join(", ")}`);
    return agent;
  });
  if (agents.length === 0) throw new Error("--agents is required, e.g. --agents tropos,claude");
  const tasks = await pickTasks(values);
  const drafts = tasks.filter((t) => t.prompt.startsWith("TODO"));
  if (drafts.length) throw new Error(`these tasks still have a TODO prompt: ${drafts.map((t) => t.id).join(", ")}`);
  if (tasks.length === 0) throw new Error("no tasks selected");
  const attempts = Number(values.attempts ?? "1");
  const concurrency = Number(values.concurrency ?? "2");
  const runOpts = { model: values.model ?? "claude-opus-5-5", effort: values.effort ?? "high" };
  const key = runKey(runOpts.model, names, process.env, await readCredentials(troposHome()));
  const secrets = { [key.envName]: key.apiKey };

  const runId = newRunId();
  const arch = await engineArch();
  const troposBinary = join(ROOT, "dist", "eval", `tropos-linux-${arch}`);
  console.error(`building tropos for linux-${arch} …`);
  sh(["bun", "build.ts", "--target", `bun-linux-${arch}`, "--outfile", troposBinary]);
  await prepareImage();

  const trials = tasks.flatMap((task) => agents.flatMap((agent) => Array.from({ length: attempts }, (_, i) => ({ task, agent, attempt: i + 1 }))));
  console.error(`run ${runId}: ${trials.length} trial(s) — ${tasks.length} task(s) × ${agents.length} agent(s) × ${attempts} attempt(s)`);
  await mkdir(RESULTS, { recursive: true });
  const out = join(RESULTS, `${runId}.jsonl`);
  const scratch = join(tmpdir(), "tcode-eval", runId);
  const results = await pool(trials, concurrency, async ({ task, agent, attempt }) => {
    const r = await runTrial(task, agent, { runId, image: IMAGE, harnessRoot: ROOT, scratch, troposBinary, attempt, run: runOpts, secrets });
    await appendFile(out, `${JSON.stringify(r)}\n`);
    const cost = r.costUsd === null ? "cost ?" : `$${r.costUsd.toFixed(2)}`;
    console.error(`${r.pass ? "PASS" : "fail"} ${task.id} · ${agent.name}#${attempt} · ${cost} · ${r.agentSeconds}s${r.harnessError ? ` · harness error: ${r.harnessError}` : ""}`);
    return r;
  });
  const report = renderMarkdown(results);
  await writeFile(join(RESULTS, `${runId}.md`), report);
  console.log(report);
  console.error(`results: ${out}`);
  return 0;
}

async function tb(values: { task?: string[]; limit?: string; agents?: string; attempts?: string; model?: string; effort?: string; concurrency?: string }): Promise<number> {
  const names = (values.agents ?? "").split(",").filter(Boolean);
  if (names.length === 0) throw new Error("--agents is required, e.g. --agents tropos,claude");
  for (const n of names) if (!TB_AGENTS[n]) throw new Error(`unknown agent "${n}"; one of ${Object.keys(TB_AGENTS).join(", ")}`);
  const model = values.model ?? "claude-opus-5-5";
  const effort = values.effort ?? "high";
  const key = runKey(model, names, process.env, await readCredentials(troposHome()));
  // harbor wants provider/model; a bare Anthropic id gets its prefix.
  const harborModel = model.includes("/") ? model : `anthropic/${model}`;
  const runId = newRunId();
  if (names.includes("tropos")) {
    // Task images are mostly linux/amd64; the baseline build also runs where x64 is emulated.
    for (const target of ["bun-linux-x64-baseline", "bun-linux-arm64"]) {
      console.error(`building tropos for ${target} …`);
      sh(["bun", "build.ts", "--target", target, "--outfile", join(ROOT, "dist", "eval", `tropos-${target.replace("bun-", "")}`)]);
    }
  }
  const jobs = join(ROOT, "eval", "tb-jobs");
  await mkdir(RESULTS, { recursive: true });
  const out = join(RESULTS, `${runId}-tb.jsonl`);
  const results: TrialResult[] = [];
  for (const name of names) {
    const job = `${runId}-${name}`;
    const args = ["uvx", "--from", HARBOR, "harbor", "run", "-d", TB_DATASET, "-a", TB_AGENTS[name]!, "-m", harborModel, "--effort", effort];
    args.push("-n", values.concurrency ?? "4", "-k", values.attempts ?? "1", "-o", jobs, "--job-name", job);
    if (values.limit) args.push("-l", values.limit);
    for (const t of values.task ?? []) args.push("-i", t);
    // Pin Claude Code to the version the private tasks use.
    if (name === "claude") args.push("--ak", `version=${CLAUDE_CODE_VERSION}`);
    console.error(`$ ${args.join(" ")}`);
    // The adapter reads the key from the variable TROPOS_KEY_ENV names, in harbor's own environment.
    const env = { ...process.env, PYTHONPATH: join(ROOT, "eval", "terminal-bench"), TROPOS_KEY_ENV: key.envName, [key.envName]: key.apiKey };
    const proc = Bun.spawn(args, { cwd: join(ROOT, "eval", "terminal-bench"), env, stdout: "inherit", stderr: "inherit" });
    if ((await proc.exited) !== 0) console.error(`harbor exited non-zero for ${name}; importing whatever trials finished`);
    if (!existsSync(join(jobs, job))) continue;
    const trials = await readHarborJob(join(jobs, job), { runId, agent: name, effort });
    for (const t of trials) await appendFile(out, `${JSON.stringify(t)}\n`);
    results.push(...trials);
  }
  const report = renderMarkdown(results);
  await writeFile(join(RESULTS, `${runId}-tb.md`), report);
  console.log(report);
  console.error(`results: ${out}\nharbor jobs: ${jobs}`);
  return 0;
}

async function report(files: string[]): Promise<number> {
  if (files.length === 0) throw new Error("report needs at least one results .jsonl file");
  const results: TrialResult[] = [];
  for (const file of files) {
    for (const line of (await readFile(file, "utf8")).split("\n")) if (line.trim()) results.push(JSON.parse(line) as TrialResult);
  }
  console.log(renderMarkdown(results));
  return 0;
}

async function newTask(values: { "from-commit"?: string; id?: string; repo?: string; split?: string }): Promise<number> {
  const sha = values["from-commit"];
  const id = values.id;
  if (!sha || !id) throw new Error("new-task needs --from-commit <sha> and --id <id>");
  const repoArg = values.repo ?? ".";
  const repo = taskRepo({ repo: repoArg } as Task, ROOT);
  const gold = sh(["git", "rev-parse", "--short=12", sha], repo);
  const base = sh(["git", "rev-parse", "--short=12", `${sha}^`], repo);
  const changed = sh(["git", "diff", "--name-only", "--diff-filter=AM", base, gold], repo).split("\n").filter(Boolean);
  const hiddenTests = changed.filter((p) => TEST_FILE.test(p));
  if (hiddenTests.length === 0) throw new Error(`${gold} changes no test files; pick a commit that adds or changes tests`);
  const dir = join(TASKS, id);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  for (const path of hiddenTests) {
    const dest = join(dir, "hidden", path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Bun.spawnSync(["git", "show", `${gold}:${path}`], { cwd: repo }).stdout);
  }
  const usesBun = Bun.spawnSync(["git", "cat-file", "-e", `${gold}:bun.lock`], { cwd: repo }).exitCode === 0;
  const message = sh(["git", "log", "-1", "--format=%B", gold], repo);
  const task = {
    id,
    repo: repoArg,
    base,
    gold,
    prompt: `TODO: describe the problem the way an issue would (symptoms and expected behaviour, not the fix). For reference, the fix commit said:\n${message}`,
    hiddenTests,
    setup: usesBun ? "bun install --frozen-lockfile" : "",
    verify: usesBun ? `bun test ${hiddenTests.map((p) => `./${p}`).join(" ")}` : "TODO",
    split: values.split ?? "dev",
    timeoutSec: 1800,
    tags: [],
  };
  await writeFile(join(dir, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  console.log(`created ${dir}\nhidden tests: ${hiddenTests.join(", ")}\nnext: write the prompt, then bun scripts/eval.ts validate --task ${id}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string", multiple: true },
      split: { type: "string" },
      agents: { type: "string" },
      attempts: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      concurrency: { type: "string" },
      limit: { type: "string" },
      "from-commit": { type: "string" },
      id: { type: "string" },
      repo: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : 64;
  }
  switch (command) {
    case "validate":
      return validate(values);
    case "run":
      return run(values);
    case "tb":
      return tb(values);
    case "report":
      return report(rest);
    case "new-task":
      return newTask(values);
    default:
      process.stderr.write(`unknown command ${command}\n${USAGE}`);
      return 64;
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`eval: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}

export { pool };
