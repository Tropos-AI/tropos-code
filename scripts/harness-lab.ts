// scripts/harness-lab.ts — the harness lab on the eval's private tasks, and the measurement of what it learned.
// `train` runs the lab on dev tasks in a home of its own (eval/harness-home, never ~/.tropos) and adopts what did
// better there. `measure` runs holdout tasks with the built-in harness and with the trained one, and judges both with
// the hidden tests, which the lab never sees. See eval/README.md.
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { HarborProbeRunner, tbTask } from "../eval/lib/harbor-probe";
import { splitTasks } from "../eval/lib/split";
import { loadTasks, selectTasks, type Task } from "../eval/lib/task";
import { taskRepo } from "../eval/lib/workspace";
import { loadSettings, settingsPaths } from "../src/config/settings";
import { EFFORTS, type Effort } from "../src/config/constants";
import { detectDomain } from "../src/harness/domain";
import { checksPassed } from "../src/harness/gate";
import { LocalProbeRunner, type LabTask, type ProbeResult } from "../src/harness/probe";
import { labOnTask, ownerProjectPaths, probeKey } from "../src/harness/service";
import { globalHarnessDir } from "../src/harness/tree";
import { Ledger } from "../src/learning/ledger";
import { troposHome } from "../src/paths";
import { ProviderRouter } from "../src/providers/router";

const ROOT = resolve(import.meta.dir, "..");
const TASKS = join(ROOT, "eval", "tasks");
const RESULTS = join(ROOT, "eval", "results");

const TB_TASKS = join(ROOT, "eval", "tb-tasks", "terminal-bench");
const TB_SPLIT = join(ROOT, "eval", "terminal-bench", "split.json");

const USAGE = `Usage:
  bun scripts/harness-lab.ts tb-split [--seed 1] [--train 30]
      Split Terminal-Bench's tasks (downloaded to eval/tb-tasks by \`harbor download terminal-bench@2.0\`) into train
      and test once, before any result is seen; written to eval/terminal-bench/split.json.
  Add --bench tb to train and measure to run on that split through harbor instead of the private tasks.
  bun scripts/harness-lab.ts train [--task <id>]... [--split dev] [--model <id>] [--editor-model <id>] [--effort high]
                                   [--k 1] [--mode parallel|sequential] [--home eval/harness-home]
      Run the harness lab on each task and adopt, in --home, what did better. Spends API money (4+ runs a task).
  bun scripts/harness-lab.ts measure [--task <id>]... [--split holdout] [--model <id>] [--attempts 1] [--home eval/harness-home]
      Run each task with the built-in harness and with --home's, and judge both with the hidden tests.
`;

/** An eval task as the lab sees it: its visible checks are the type checker and the old versions of the test files. */
function labTask(task: Task): LabTask {
  const repo = taskRepo(task, ROOT);
  return {
    id: task.id,
    title: task.prompt.split("\n")[0]!.slice(0, 80),
    prompt: task.prompt,
    repo,
    revision: task.base,
    domain: detectDomain(repo),
    ...(task.setup ? { setup: task.setup } : {}),
    checks: ["bun x tsc --noEmit", `bun test ${task.hiddenTests.map((t) => `./${t}`).join(" ")}`],
    split: task.split,
  };
}

async function tools(values: { model?: string; "editor-model"?: string; effort?: string }) {
  const home = troposHome();
  const { settings } = await loadSettings(settingsPaths(ROOT, home));
  const model = values.model ?? settings.model;
  const effort = (values.effort ?? settings.effort) as Effort;
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  const env = { ...process.env, ...settings.env };
  const key = await probeKey(home, model, env);
  if (!key) throw new Error(`no API key for ${model}: set its variable or connect it with /providers`);
  const otherProjects = await ownerProjectPaths(home);
  const runner = (keepWorkspace = false) =>
    new LocalProbeRunner({ otherProjects, command: [process.execPath, join(ROOT, "src", "index.ts")], model, effort, maxTurns: 80, timeoutMs: 30 * 60_000, key, providers: settings.providers as Record<string, unknown>, ownerHome: home, keepWorkspace });
  const llm = { model: new ProviderRouter({ home, env, settings: settings.providers }), id: values["editor-model"] ?? model, effort };
  return { model, effort, key, runner, llm };
}

/** Probes through harbor, for --bench tb: the task's container is the sandbox. */
function tbRunner(model: string, effort: string, key: { name: string; value: string }): HarborProbeRunner {
  return new HarborProbeRunner({ agentDir: join(ROOT, "eval", "terminal-bench"), model: model.includes("/") ? model : `anthropic/${model}`, effort, key });
}

/** The Linux builds harbor uploads into the task containers (as `bun scripts/eval.ts tb` makes them). */
function buildTbBinaries(): void {
  for (const target of ["bun-linux-x64-baseline", "bun-linux-arm64"]) {
    console.error(`building tropos for ${target} …`);
    const r = Bun.spawnSync(["bun", "build.ts", "--target", target, "--outfile", join(ROOT, "dist", "eval", `tropos-${target.replace("bun-", "")}`)], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`building ${target} failed`);
  }
}

async function tbSplit(values: Record<string, string | string[] | undefined>): Promise<number> {
  if (!existsSync(TB_TASKS)) throw new Error(`no tasks at ${TB_TASKS}: run \`uvx --from harbor==0.24.0 harbor download terminal-bench@2.0 -o eval/tb-tasks\``);
  if (existsSync(TB_SPLIT)) throw new Error(`${TB_SPLIT} exists: the split is made once; delete it on purpose to make another`);
  const names = (await readdir(TB_TASKS, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const seed = Number(values.seed ?? "1");
  const train = Number(values.train ?? "30");
  const split = splitTasks(names, seed, train);
  await writeFile(TB_SPLIT, `${JSON.stringify({ dataset: "terminal-bench@2.0", seed, ...split }, null, 2)}\n`);
  console.log(`${split.train.length} train, ${split.test.length} test tasks: ${TB_SPLIT}`);
  return 0;
}

async function tbTasks(values: Record<string, string | string[] | undefined>, part: "train" | "test"): Promise<LabTask[]> {
  if (!existsSync(TB_SPLIT)) throw new Error("no split yet: run tb-split first");
  const split = JSON.parse(await readFile(TB_SPLIT, "utf8")) as { train: string[]; test: string[] };
  const names = (values.task as string[] | undefined) ?? split[part];
  const outside = names.filter((n) => !split[part].includes(n));
  if (outside.length) throw new Error(`not in the ${part} split: ${outside.join(", ")}`);
  return Promise.all(names.map((n) => tbTask(TB_TASKS, n, part === "train" ? "dev" : "holdout")));
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

async function train(values: Record<string, string | string[] | undefined>, tasks: LabTask[]): Promise<number> {
  const labHome = resolve(ROOT, (values.home as string | undefined) ?? (values.bench === "tb" ? "eval/harness-home-tb" : "eval/harness-home"));
  const { model, effort, key, runner: localRunner, llm } = await tools(values as Record<string, string>);
  const runner = values.bench === "tb" ? () => tbRunner(model, effort, key) : () => localRunner();
  if (values.bench === "tb") buildTbBinaries();
  const k = Number(values.k ?? "1");
  const mode = (values.mode as string | undefined) ?? "parallel";
  if (!Number.isInteger(k) || k < 1 || k > 8) throw new Error("--k must be 1 to 8");
  if (mode !== "parallel" && mode !== "sequential") throw new Error("--mode must be parallel or sequential");
  await mkdir(labHome, { recursive: true });
  for (const task of tasks) {
    console.error(`\ntrain ${task.id} (${task.split})`);
    const r = await labOnTask(task, {
      home: labHome, runner: runner(), llm, model, scope: "global", k, mode, autoAdopt: true, ledger: new Ledger(labHome),
      signal: new AbortController().signal, log: (line) => console.error(`  ${line}`),
    });
    console.error(`  verdict ${r.run.verdict.outcome}${r.adopted ? ", adopted" : r.run.candidate ? `, candidate ${r.run.candidate} (${r.pending ?? "not adopted"})` : ""}; ${r.reflection.lessons.length} lesson(s); $${(r.run.costUsd ?? 0).toFixed(2)}`);
  }
  console.log(`Trained harness: ${globalHarnessDir(labHome)}`);
  return 0;
}

interface Measurement {
  task: string;
  split: string;
  harness: "built-in" | "trained";
  attempt: number;
  pass: boolean;
  checks: number;
  turns: number;
  toolErrors: number;
  costUsd: number | null;
  error: string | null;
}

async function measure(values: Record<string, string | string[] | undefined>, tasks: LabTask[], evalTasks: Map<string, Task>): Promise<number> {
  const labHome = resolve(ROOT, (values.home as string | undefined) ?? (values.bench === "tb" ? "eval/harness-home-tb" : "eval/harness-home"));
  const attempts = Number(values.attempts ?? "1");
  const { model, effort, key, runner: localRunner } = await tools(values as Record<string, string>);
  const runner = values.bench === "tb" ? () => tbRunner(model, effort, key) : () => localRunner();
  if (values.bench === "tb") buildTbBinaries();
  const scratch = await mkdtemp(join(tmpdir(), "harness-measure-"));
  const builtIn = join(scratch, "built-in");
  await mkdir(builtIn, { recursive: true });
  // Nothing adopted yet: both sides run the built-in harness, and the difference is the noise.
  let trained = globalHarnessDir(labHome);
  if (!existsSync(trained)) {
    console.error(`no trained harness at ${trained}: both sides run the built-in one, so any difference is noise`);
    trained = builtIn;
  }
  const id = `${stamp()}-harness`;
  await mkdir(RESULTS, { recursive: true });
  const out = join(RESULTS, `${id}.jsonl`);
  const rows: Measurement[] = [];
  for (const task of tasks) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      for (const [harness, dir] of [["built-in", builtIn], ["trained", trained]] as const) {
        const label = `${task.id}-${harness}-${attempt}`;
        const probeDir = join(scratch, label);
        await mkdir(probeDir, { recursive: true });
        // A private task's hidden tests are copied in last; a Terminal-Bench trial's verifier measures it by itself.
        const hidden = evalTasks.get(task.id);
        const r: ProbeResult = await runner().run(
          { task, harnessDir: dir, dir: probeDir, id: label, label, harnessFiles: [], ...(hidden ? { measure: { from: join(hidden.dir, "hidden"), files: hidden.hiddenTests, command: hidden.verify } } : {}) },
          new AbortController().signal,
        );
        const row: Measurement = {
          task: task.id, split: task.split, harness, attempt, pass: r.measured?.ok ?? false, checks: checksPassed(r), turns: r.signals.turns, toolErrors: r.signals.toolErrors, costUsd: r.signals.costUsd, error: r.error,
        };
        rows.push(row);
        await appendFile(out, `${JSON.stringify(row)}\n`);
        console.error(`${row.pass ? "PASS" : "fail"} ${label} · ${row.turns} turns · ${row.toolErrors} tool errors${row.error ? ` · ${row.error}` : ""}`);
      }
    }
  }
  const summary = (["built-in", "trained"] as const).map((h) => {
    const of = rows.filter((r) => r.harness === h);
    const avg = (f: (r: Measurement) => number) => (of.length ? of.reduce((s, r) => s + f(r), 0) / of.length : 0);
    return `| ${h} | ${of.filter((r) => r.pass).length}/${of.length} | ${avg((r) => r.turns).toFixed(1)} | ${avg((r) => r.toolErrors).toFixed(1)} | $${of.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(2)} |`;
  });
  const report = [`Harness measurement ${id} (${tasks.length} tasks × ${attempts} attempts)`, "", "| harness | hidden tests passed | mean turns | mean tool errors | cost |", "|---|---|---|---|---|", ...summary, ""].join("\n");
  await writeFile(join(RESULTS, `${id}.md`), report);
  console.log(report);
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  strict: true,
  options: {
    task: { type: "string", multiple: true },
    split: { type: "string" },
    model: { type: "string" },
    "editor-model": { type: "string" },
    effort: { type: "string" },
    k: { type: "string" },
    mode: { type: "string" },
    attempts: { type: "string" },
    home: { type: "string" },
    bench: { type: "string" },
    seed: { type: "string" },
    train: { type: "string" },
  },
});
if (command === "tb-split") process.exit(await tbSplit(values));
if (command !== "train" && command !== "measure") {
  console.error(USAGE);
  process.exit(64);
}
if (values.bench !== undefined && values.bench !== "tb") {
  console.error("--bench must be tb (or left out for the private tasks)");
  process.exit(64);
}
let tasks: LabTask[];
const evalTasks = new Map<string, Task>();
if (values.bench === "tb") tasks = await tbTasks(values, command === "train" ? "train" : "test");
else {
  const split = (values.split ?? (command === "train" ? "dev" : "holdout")) as Task["split"];
  const selected = selectTasks(await loadTasks(TASKS), { ids: values.task, split });
  for (const t of selected) evalTasks.set(t.id, t);
  tasks = selected.map(labTask);
}
if (tasks.length === 0) {
  console.error("no tasks selected");
  process.exit(1);
}
process.exit(command === "train" ? await train(values, tasks) : await measure(values, tasks, evalTasks));
