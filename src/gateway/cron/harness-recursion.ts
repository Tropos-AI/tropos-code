// src/gateway/cron/harness-recursion.ts — a scheduled job run through the harness lab (`harnessRecursion: k`): the
// task runs with the current harness and with k composed ones, each in its own confined copy of the project; the best
// attempt that didn't weaken tests becomes a branch in a worktree of the real repository for the owner to merge. A
// scheduled job has nobody waiting for it, so the four-plus runs cost time, not patience.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { weakenedTests } from "../../harness/audit";
import { checksPassed, rankProbes } from "../../harness/gate";
import { labDir, type LabRun } from "../../harness/lab";
import type { ProbeResult } from "../../harness/probe";
import { labOnTask, labTools, taskFromPrompt, type LabTaskResult } from "../../harness/service";
import { loadSettings, settingsPaths } from "../../config/settings";
import { Ledger } from "../../learning/ledger";
import { ProviderRouter } from "../../providers/router";
import { createWorktree, hostGit, type GitRun } from "../worktrees";
import type { CronJob } from "./types";

/** The attempt to hand over: the selector's pick when there was one, else the best valid run (the reference included). */
export function deliverable(run: LabRun): ProbeResult | undefined {
  const valid = run.probes.filter((p) => !p.error && !(p.audit && weakenedTests(p.audit)));
  const selected = run.selected ? valid.find((p) => p.id === run.selected!.id) : undefined;
  const best = rankProbes(valid)[0];
  // The selector chose among improvements; a reference that passes more checks still wins.
  return selected && best && checksPassed(best) > checksPassed(selected) ? best : (selected ?? best);
}

export interface HandOver {
  text: string;
  branch?: string;
}

/** Puts the chosen attempt's patch on a new branch in a worktree of `repo`, committed, and says where. */
export async function handOver(o: { home: string; job: CronJob; repo: string; result: LabTaskResult; git?: GitRun; now?: () => Date }): Promise<HandOver> {
  const { run } = o.result;
  const k = run.k;
  const harness = `Harness: ${run.verdict.outcome}${run.verdict.reasons[0] ? ` (${run.verdict.reasons[0]})` : ""}${o.result.adopted ? `; adopted, undo with tcode harness revert ${o.result.adopted.id}` : run.candidate ? `; candidate ${run.candidate} waits for you` : ""}.`;
  const best = deliverable(run);
  if (!best) return { text: `Ran "${o.job.name}" through the harness lab (k=${k}); no attempt finished without errors. ${harness}` };
  const patch = await readFile(join(labDir(o.home, run.id), best.label, "patch.diff"), "utf8").catch(() => "");
  const checks = `${checksPassed(best)}/${best.checks.length} checks`;
  if (!patch.trim()) return { text: `Ran "${o.job.name}" through the harness lab (k=${k}); the best attempt (${checks}) changed nothing.\n${best.finalText}\n${harness}` };
  const git = o.git ?? hostGit;
  const worktree = await createWorktree({ home: o.home, key: `cron:${o.job.id}`, projectId: o.job.project, repo: o.repo, git, ...(o.now ? { now: o.now } : {}) });
  if (!worktree) return { text: `Ran "${o.job.name}" (k=${k}); the repository has no commit to branch from. The patch is in ${join(labDir(o.home, run.id), best.label, "patch.diff")}. ${harness}` };
  const patchFile = join(labDir(o.home, run.id), best.label, "patch.diff");
  const applied = await git(["apply", "--index", "--whitespace=nowarn", patchFile], worktree.path);
  if (applied.code !== 0) {
    return { text: `Ran "${o.job.name}" (k=${k}); the best attempt (${checks}) didn't apply to ${worktree.branch}: ${applied.stderr.trim()}. The patch is in ${patchFile}. ${harness}`, branch: worktree.branch };
  }
  const committed = await git(["commit", "-q", "-m", `${o.job.name}: ${run.task.title}`, "-m", `From the harness lab run ${run.id} (${best.label}, ${checks}).`], worktree.path);
  const state = committed.code === 0 ? "committed" : `staged (the commit failed: ${committed.stderr.trim()})`;
  return {
    text: `Ran "${o.job.name}" through the harness lab (k=${k}). The best attempt (${best.label}, ${checks}) is ${state} on branch ${worktree.branch} in ${worktree.path}; merge it when it looks right.\n${best.finalText}\n${harness}`,
    branch: worktree.branch,
  };
}

/** The daemon's `recursive` for the job runner: the lab with the owner's settings, then the hand-over. */
export function recursiveJobRunner(o: { home: string; command: string[]; env: NodeJS.ProcessEnv }): (job: CronJob, cwd: string, signal: AbortSignal) => Promise<{ text: string }> {
  return async (job, cwd, signal) => {
    const { settings } = await loadSettings(settingsPaths(cwd, o.home));
    const env = { ...o.env, ...settings.env };
    const task = await taskFromPrompt(cwd, job.prompt);
    const { runner, llm } = await labTools({
      home: o.home,
      env,
      command: o.command,
      router: new ProviderRouter({ home: o.home, env, settings: settings.providers }),
      providers: settings.providers as Record<string, unknown>,
      models: { model: settings.model, effort: settings.effort, ...(settings.harness.editorModel ? { editorModel: settings.harness.editorModel } : {}) },
    });
    const result = await labOnTask(task, {
      home: o.home,
      runner,
      llm,
      model: settings.model,
      scope: "global",
      k: job.harnessRecursion ?? 1,
      mode: "parallel",
      autoAdopt: settings.harness.autoAdopt,
      ledger: new Ledger(o.home),
      signal,
    });
    if (signal.aborted) throw new Error("stopped");
    return { text: (await handOver({ home: o.home, job, repo: task.repo, result })).text };
  };
}
