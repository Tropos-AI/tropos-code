// scripts/harness-lab.ts — the harness lab on the eval's private tasks, and the measurement of what it learned.
// `train` runs the lab on dev tasks in a home of its own (eval/harness-home, never ~/.tropos) and adopts what did
// better there. `measure` runs holdout tasks with the built-in harness and with the trained one, and judges both with
// the hidden tests, which the lab never sees. See eval/README.md.
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { HarborProbeRunner, tbTask } from "../eval/lib/harbor-probe";
import { renderMeasurement, type Measurement } from "../eval/lib/harness-report";
import { splitTasks } from "../eval/lib/split";
import { loadTasks, selectTasks, type Task } from "../eval/lib/task";
import { taskRepo } from "../eval/lib/workspace";
import { loadSettings, settingsPaths } from "../src/config/settings";
import { EFFORTS, type Effort } from "../src/config/constants";
import { detectDomain } from "../src/harness/domain";
import { checksPassed } from "../src/harness/gate";
import { LocalProbeRunner, type LabTask, type ProbeResult } from "../src/harness/probe";
import { labOnTask, ownerProjectPaths, probeKey } from "../src/harness/service";
import { BASE_TREE } from "../src/harness/base";
import { listCandidates, readCandidate } from "../src/harness/candidates";
import { DOMAINS } from "../src/harness/domain";
import { lessonsSkillDir, globalHarnessDir, validateTree } from "../src/harness/tree";
import { Ledger } from "../src/learning/ledger";
import { troposHome } from "../src/paths";
import { ProviderRouter } from "../src/providers/router";

const ROOT = resolve(import.meta.dir, "..");
const TASKS = join(ROOT, "eval", "tasks");
const RESULTS = join(ROOT, "eval", "results");

const TB_TASKS = join(ROOT, "eval", "tb-tasks", "terminal-bench");
const TB_SPLIT = join(ROOT, "eval", "terminal-bench", "split.json");

type Values = Record<string, string | string[] | boolean | undefined>;

const USAGE = `Usage:
  bun scripts/harness-lab.ts train [--bench tb] [--task <id>]... [--model <id>] [--editor-model <id>] [--effort high]
                                   [--k 1] [--mode parallel|sequential] [--adopt never|confirmed] [--home <dir>]
      Run the harness lab on each train task (the private dev tasks, or with --bench tb Terminal-Bench's train split).
      --adopt confirmed (the default on private tasks) adopts what did better twice in a row; on Terminal-Bench the
      default is never, and every task starts from the built-in harness. Spends API money (4+ runs a task).
  bun scripts/harness-lab.ts assemble [--home <dir>] [--candidate <id>]... [--lessons] --out <dir>
      Build a harness to measure from chosen candidates and the library's lessons.
  bun scripts/harness-lab.ts measure [--bench tb] [--task <id>]... [--model <id>] [--attempts 2] [--harness <dir>] [--home <dir>]
      Run each test task with the built-in harness and with --harness (default: what train adopted), judge both with
      the hidden tests or Terminal-Bench's verifier, and report the totals and, per task, which harness solved it.
  bun scripts/harness-lab.ts plan [eval/lab-run.json]      The CI matrix for a run described in that file.
  bun scripts/harness-lab.ts candidates [--home <dir>]      What train left, to read before assemble.
  bun scripts/harness-lab.ts report <measurements.jsonl>... One report from several measure runs (CI shards).
  bun scripts/harness-lab.ts tb-split [--seed 1] [--train 30]
      Split Terminal-Bench's tasks (downloaded to eval/tb-tasks by \`harbor download terminal-bench@2.0\`) into train
      and test once, before any result is seen; written to eval/terminal-bench/split.json.
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

async function tbSplit(values: Values): Promise<number> {
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

async function tbTasks(values: Values, part: "train" | "test"): Promise<LabTask[]> {
  if (!existsSync(TB_SPLIT)) throw new Error("no split yet: run tb-split first");
  const split = JSON.parse(await readFile(TB_SPLIT, "utf8")) as { train: string[]; test: string[] };
  const names = (values.task as string[] | undefined) ?? split[part];
  const outside = names.filter((n) => !split[part].includes(n));
  if (outside.length) throw new Error(`not in the ${part} split: ${outside.join(", ")}`);
  return Promise.all(names.map((n) => tbTask(TB_TASKS, n, part === "train" ? "dev" : "holdout")));
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

async function train(values: Values, tasks: LabTask[]): Promise<number> {
  const labHome = resolve(ROOT, (values.home as string | undefined) ?? (values.bench === "tb" ? "eval/harness-home-tb" : "eval/harness-home"));
  const { model, effort, key, runner: localRunner, llm } = await tools(values as Record<string, string>);
  const runner = values.bench === "tb" ? () => tbRunner(model, effort, key) : () => localRunner();
  if (values.bench === "tb") buildTbBinaries();
  const k = Number(values.k ?? "1");
  const mode = (values.mode as string | undefined) ?? "parallel";
  if (!Number.isInteger(k) || k < 1 || k > 8) throw new Error("--k must be 1 to 8");
  if (mode !== "parallel" && mode !== "sequential") throw new Error("--mode must be parallel or sequential");
  // On Terminal-Bench the lab judges only how the agent worked: nothing is adopted by default, and every task starts
  // from the built-in harness (as in the paper), so one lucky run can't become the next task's starting point.
  const adopt = (values.adopt as string | undefined) ?? (values.bench === "tb" ? "never" : "confirmed");
  if (adopt !== "never" && adopt !== "confirmed") throw new Error("--adopt must be never or confirmed");
  await mkdir(labHome, { recursive: true });
  for (const task of tasks) {
    console.error(`\ntrain ${task.id} (${task.split})`);
    const r = await labOnTask(task, {
      home: labHome, runner: runner(), llm, model, scope: "global", k, mode, autoAdopt: adopt === "confirmed", confirm: true,
      ...(values.bench === "tb" ? { startFrom: BASE_TREE } : {}),
      ledger: new Ledger(labHome), signal: new AbortController().signal, log: (line) => console.error(`  ${line}`),
    });
    console.error(`  verdict ${r.run.verdict.outcome}${r.adopted ? ", adopted" : r.run.candidate ? `, candidate ${r.run.candidate} (${r.pending ?? "not adopted"})` : ""}; ${r.reflection.lessons.length} lesson(s); $${(r.run.costUsd ?? 0).toFixed(2)}`);
  }
  console.log(adopt === "never" ? `Candidates: ${labHome}/harness/candidates (read them, then: assemble --home ${labHome} --candidate <id>... --out <dir>)` : `Trained harness: ${globalHarnessDir(labHome)}`);
  return 0;
}

interface LabRunConfig {
  command: "train" | "measure";
  bench?: "tb";
  model: string;
  editorModel?: string;
  /** The tasks; by default the split's train or test part (Terminal-Bench) or the dev/holdout tasks. */
  tasks?: string[];
  /** Only the first `limit` of them: a pilot. */
  limit?: number;
  /** Jobs to spread the tasks over (CI jobs stop after 6 hours). */
  shards: number;
  attempts?: number;
  /** For measure: the harness to measure, a folder in the repository (assemble makes one). */
  harness?: string;
  k?: number;
}

/**
 * The CI matrix for a run described in a JSON file (.github/workflows/harness-lab.yml): one entry per shard, each with
 * the arguments of this script for its tasks. Printed as {"include": [...]}.
 */
async function plan(file: string): Promise<number> {
  const config = JSON.parse(await readFile(resolve(ROOT, file), "utf8")) as LabRunConfig;
  if (config.command !== "train" && config.command !== "measure") throw new Error(`${file}: command must be train or measure`);
  if (!config.model) throw new Error(`${file}: model is required`);
  let tasks = config.tasks;
  if (!tasks) {
    if (config.bench === "tb") {
      const split = JSON.parse(await readFile(TB_SPLIT, "utf8")) as { train: string[]; test: string[] };
      tasks = split[config.command === "train" ? "train" : "test"];
    } else tasks = selectTasks(await loadTasks(TASKS), { split: config.command === "train" ? "dev" : "holdout" }).map((t) => t.id);
  }
  tasks = tasks.slice(0, config.limit ?? tasks.length);
  // Every word ends up on a CI command line: only plain names, model ids and repository paths.
  const word = (what: string, value: string, pattern: RegExp) => {
    if (!pattern.test(value)) throw new Error(`${file}: ${what} "${value}" isn't allowed here`);
  };
  for (const t of tasks) word("task", t, /^[a-z0-9][a-z0-9._-]*$/);
  word("model", config.model, /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
  if (config.editorModel) word("editorModel", config.editorModel, /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
  if (config.harness) word("harness", config.harness, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
  if (config.harness?.split("/").includes("..")) throw new Error(`${file}: harness must be a folder in the repository`);
  for (const [what, n] of [["shards", config.shards], ["attempts", config.attempts ?? 1], ["k", config.k ?? 1], ["limit", config.limit ?? 1]] as const) {
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`${file}: ${what} must be a whole number from 1 to 100`);
  }
  const shards = Math.max(1, Math.min(config.shards, tasks.length));
  const common = [
    config.command,
    ...(config.bench ? ["--bench", config.bench] : []),
    "--model", config.model,
    ...(config.editorModel ? ["--editor-model", config.editorModel] : []),
    ...(config.attempts ? ["--attempts", String(config.attempts)] : []),
    ...(config.harness ? ["--harness", config.harness] : []),
    ...(config.k ? ["--k", String(config.k)] : []),
  ];
  const include = Array.from({ length: shards }, (_, i) => {
    const mine = tasks.filter((_, j) => j % shards === i);
    return { shard: i + 1, args: [...common, ...mine.flatMap((t) => ["--task", t])].join(" ") };
  });
  console.log(JSON.stringify({ include }));
  return 0;
}

/** One report from the measurements of several runs (each CI shard writes its own .jsonl). */
async function report(files: string[]): Promise<number> {
  if (files.length === 0) throw new Error("report needs the measurement .jsonl files");
  const rows: Measurement[] = [];
  for (const file of files) for (const line of (await readFile(file, "utf8")).split("\n")) if (line.trim()) rows.push(JSON.parse(line) as Measurement);
  const attempts = Math.max(...rows.map((r) => r.attempt));
  console.log(renderMeasurement(`${files.length} file(s)`, rows, attempts));
  return 0;
}

/** What train left: each candidate with its task, verdict and files, for reading before assemble. */
async function candidates(values: Values): Promise<number> {
  const labHome = resolve(ROOT, (values.home as string | undefined) ?? "eval/harness-home-tb");
  const all = await listCandidates(labHome);
  if (all.length === 0) console.log("No candidates.");
  for (const c of all) {
    console.log(`## ${c.id} · ${c.task.title} (${c.task.id})`);
    console.log(`Verdict: ${c.verdict?.outcome ?? "untested"}${c.verdict?.reasons.length ? ` (${c.verdict.reasons.join("; ")})` : ""}`);
    if (c.rationale) console.log(c.rationale);
    for (const [path, value] of Object.entries(c.changes)) console.log(`\n### ${path}\n${value === null ? "(removed)" : value}`);
    console.log("");
  }
  return 0;
}

/** The harness to measure: chosen candidates' changes, in order, and with --lessons the library's lessons skill. */
async function assemble(values: Values): Promise<number> {
  const labHome = resolve(ROOT, (values.home as string | undefined) ?? "eval/harness-home-tb");
  const out = values.out as string | undefined;
  if (!out) throw new Error("assemble needs --out <dir>");
  const files = new Map<string, string>();
  for (const id of (values.candidate as string[] | undefined) ?? []) {
    const c = await readCandidate(labHome, id);
    if (!c) throw new Error(`no candidate ${id} in ${labHome}`);
    for (const [path, value] of Object.entries(c.changes)) {
      if (value === null) files.delete(path);
      else files.set(path, value);
    }
  }
  if (values.lessons) {
    for (const domain of DOMAINS) {
      const skill = join(lessonsSkillDir(labHome, domain), `harness-lessons-${domain}`, "SKILL.md");
      if (existsSync(skill)) files.set(`skills/harness-lessons-${domain}/SKILL.md`, await readFile(skill, "utf8"));
    }
  }
  const broken = validateTree(new Map([...BASE_TREE, ...files]));
  if (broken.length) throw new Error(`the assembled harness breaks a rule: ${broken.join("; ")}`);
  const dir = resolve(ROOT, out);
  for (const [path, text] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  console.log(`${files.size} file(s) in ${dir}: measure --harness ${out}`);
  return 0;
}


async function measure(values: Values, tasks: LabTask[], evalTasks: Map<string, Task>): Promise<number> {
  const labHome = resolve(ROOT, (values.home as string | undefined) ?? (values.bench === "tb" ? "eval/harness-home-tb" : "eval/harness-home"));
  const attempts = Number(values.attempts ?? "2");
  const { model, effort, key, runner: localRunner } = await tools(values as Record<string, string>);
  const runner = values.bench === "tb" ? () => tbRunner(model, effort, key) : () => localRunner();
  if (values.bench === "tb") buildTbBinaries();
  const scratch = await mkdtemp(join(tmpdir(), "harness-measure-"));
  const builtIn = join(scratch, "built-in");
  await mkdir(builtIn, { recursive: true });
  // --harness names the harness to measure (assemble makes one); else what train adopted. With neither, both sides run
  // the built-in harness, and the difference is the noise.
  let trained = values.harness ? resolve(ROOT, values.harness as string) : globalHarnessDir(labHome);
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
  const report = renderMeasurement(id, rows, attempts);
  await writeFile(join(RESULTS, `${id}.md`), report);
  console.log(report);
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  strict: true,
  allowPositionals: true,
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
    adopt: { type: "string" },
    harness: { type: "string" },
    candidate: { type: "string", multiple: true },
    lessons: { type: "boolean" },
    out: { type: "string" },
  },
});
if (command === "tb-split") process.exit(await tbSplit(values));
if (command === "plan") process.exit(await plan(positionals[0] ?? "eval/lab-run.json"));
if (command === "assemble") process.exit(await assemble(values));
if (command === "report") process.exit(await report(positionals));
if (command === "candidates") process.exit(await candidates(values));
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
