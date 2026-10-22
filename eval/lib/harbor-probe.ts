// eval/lib/harbor-probe.ts — the harness lab's probe on a Terminal-Bench task: one harbor trial of the task with the
// harness under test uploaded into the task's container (eval/terminal-bench/tropos_agent.py, TROPOS_HARNESS_DIR).
// The container is the sandbox. Terminal-Bench tasks have no checks of their own besides the verifier, which is the
// benchmark's hidden test: its verdict is kept as `measured` only, so the lab judges these runs on how the agent
// worked, and the verifier is read only when measuring.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LabTask, ProbeInput, ProbeResult, ProbeRunner } from "../../src/harness/probe";
import { behaviourSignals, parseTrajectory } from "../../src/harness/signals";
import type { HarborTrial } from "./harbor";

export const HARBOR = "harbor==0.24.0";
export const TB_DATASET = "terminal-bench@2.0";

export interface HarborProbeOptions {
  /** How to start harbor: ["uvx", "--from", HARBOR, "harbor"] by default; tests stand in for it. */
  harbor?: string[];
  /** The folder holding tropos_agent.py (put on PYTHONPATH). */
  agentDir: string;
  /** harbor's model name: provider/model, e.g. anthropic/claude-haiku-5-5. */
  model: string;
  effort: string;
  /** The model provider's key and the variable that carries it. */
  key: { name: string; value: string };
  dataset?: string;
}

/** Exceptions that are the agent's own failure (a failed run), as opposed to the harness breaking (no result). */
const AGENT_FAILURE = /^(NonZeroAgentExitCode|Api\w*|OutputTokenExceeded|ContextWindowExceeded|AgentSafetyRefusal|UnknownApi|AgentTimeout)Error$/;

async function findFile(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const hit = entries.find((e) => e.isFile() && e.name === name);
  return hit ? join(hit.parentPath, hit.name) : undefined;
}

/** The trial's result.json: in the trial's own folder (the job keeps a result.json of its own one level up). */
async function trialResult(jobDir: string): Promise<string | undefined> {
  const entries = await readdir(jobDir, { withFileTypes: true }).catch(() => []);
  const trial = entries.find((e) => e.isDirectory() && existsSync(join(jobDir, e.name, "result.json")));
  return trial ? join(jobDir, trial.name, "result.json") : undefined;
}

async function hasFiles(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.some((e) => e.isFile());
}

/** A Terminal-Bench task as the lab sees it: its instruction is the prompt, and it has no checks of its own. */
export async function tbTask(tasksDir: string, name: string, split: LabTask["split"]): Promise<LabTask> {
  const instruction = (await readFile(join(tasksDir, name, "instruction.md"), "utf8")).trim();
  return { id: name, title: instruction.split("\n")[0]!.slice(0, 80), prompt: instruction, repo: "", revision: "", domain: "general", checks: [], split };
}

export class HarborProbeRunner implements ProbeRunner {
  constructor(private readonly opts: HarborProbeOptions) {}

  async run(input: ProbeInput, signal: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    const result: ProbeResult = {
      id: input.id, label: input.label, harness: input.harnessFiles, signals: behaviourSignals([]), checks: [], audit: null, finalText: "", seconds: 0, error: null,
    };
    const jobs = join(input.dir, "harbor");
    try {
      signal.throwIfAborted();
      await mkdir(jobs, { recursive: true });
      const harbor = this.opts.harbor ?? ["uvx", "--from", HARBOR, "harbor"];
      const args = [...harbor, "run", "-d", this.opts.dataset ?? TB_DATASET, "-a", "tropos_agent:TroposAgent", "-m", this.opts.model, "--effort", this.opts.effort, "-n", "1", "-k", "1", "-o", jobs, "--job-name", input.id, "-i", input.task.id];
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PYTHONPATH: this.opts.agentDir,
        TROPOS_KEY_ENV: this.opts.key.name,
        [this.opts.key.name]: this.opts.key.value,
      };
      // Only a harness with files goes up; an empty one is the built-in harness, and the container needs no folder.
      if (await hasFiles(input.harnessDir)) env.TROPOS_HARNESS_DIR = input.harnessDir;
      else delete env.TROPOS_HARNESS_DIR;
      const child = Bun.spawn(args, { cwd: this.opts.agentDir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const kill = () => child.kill("SIGTERM");
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      signal.removeEventListener("abort", kill);
      signal.throwIfAborted();

      const resultFile = await trialResult(join(jobs, input.id));
      if (!resultFile) throw new Error(`harbor left no trial result: ${(err || out).slice(-800)}`);
      const trial = JSON.parse(await readFile(resultFile, "utf8")) as HarborTrial;
      const exception = trial.exception_info;
      if (exception && !AGENT_FAILURE.test(exception.exception_type ?? "")) {
        throw new Error(`${exception.exception_type}: ${(exception.exception_message ?? "").slice(0, 500)}`);
      }
      const log = await findFile(join(jobs, input.id), "tropos.jsonl");
      const stdout = log ? await readFile(log, "utf8") : "";
      await writeFile(join(input.dir, "trajectory.jsonl"), stdout);
      const events = parseTrajectory(stdout);
      result.signals = behaviourSignals(events);
      if (!result.signals.endReason && exception) result.signals.endReason = exception.exception_type ?? "error";
      const final = [...events].reverse().find((e) => e.type === "result");
      result.finalText = typeof final?.result === "string" ? final.result.slice(0, 4_000) : "";
      // No diff to show: the work happened in the task's container.
      await writeFile(join(input.dir, "patch.diff"), "");
      const reward = trial.verifier_result?.rewards?.reward;
      result.measured = { command: "the Terminal-Bench verifier", ok: reward !== undefined && reward >= 1, exit: null, timedOut: /timeout/i.test(exception?.exception_type ?? ""), tail: `reward ${reward ?? "none"}`, seconds: 0 };
      await copyFile(resultFile, join(input.dir, "trial.json")).catch(() => {});
    } catch (e) {
      result.error = signal.aborted ? "stopped before it finished" : (e as Error).message;
    } finally {
      result.seconds = Math.round((performance.now() - started) / 1000);
      await writeFile(join(input.dir, "probe.json"), `${JSON.stringify(result, null, 2)}\n`).catch(() => {});
      // harbor's job folders hold container logs and copies of the task: what the lab reads is copied out above.
      await rm(jobs, { recursive: true, force: true });
    }
    return result;
  }
}
