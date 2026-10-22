// src/harness/service.ts — running the harness lab for real: tasks from a prompt, from past sessions (replay) or from a
// file; the executor and editor models; the probe runner; then lab, reflection and, when allowed, adoption. Shared by
// `tcode harness lab`, the gateway's weekly lab and scheduled jobs with harness recursion.
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "../api/model";
import type { Effort } from "../config/constants";
import { gitRoot } from "../context/memory";
import { loadGatewayConfig } from "../gateway/config";
import { hostGit } from "../gateway/worktrees";
import { guestWorkspaceDir, workspaceDir } from "../paths";
import type { Settings } from "../config/settings";
import { Ledger } from "../learning/ledger";
import { ProviderRouter } from "../providers/router";
import { readCredentials, resolveApiKey } from "../providers/credentials";
import { parseModelId } from "../providers/registry";
import { projectDir, readSessionFile } from "../session/store";
import type { MessageParam } from "../session/store";
import { adoptCandidate, candidateRunsCode, listCandidates, readCandidate, saveCandidate, type Candidate } from "./candidates";
import { detectDomain } from "./domain";
import { runLab, type LabRun } from "./lab";
import { libraryMaterial } from "./library";
import type { LlmConfig } from "./llm";
import { LocalProbeRunner, type LabTask, type ProbeRunner } from "./probe";
import { applyChanges, type Changes } from "./propose";
import { reflect, type Reflection } from "./reflect";
import { BASE_TREE } from "./base";
import { globalHarnessDir, loadHarness, overlay, readLayer, validateTree, type HarnessTree } from "./tree";
import { defaultChecks, defaultSetup } from "./workspace";

async function git(args: string[], cwd: string): Promise<string> {
  const r = await hostGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const title = (prompt: string) => {
  const line = prompt.trim().split("\n")[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
};

export interface TaskOptions {
  /** The revision to start from (default HEAD). */
  revision?: string;
  setup?: string;
  checks?: string[];
}

/** A task on the project around `cwd`, at its committed state; uncommitted changes are not part of it. */
export async function taskFromPrompt(cwd: string, prompt: string, opts: TaskOptions = {}, id = "prompt"): Promise<LabTask> {
  const repo = gitRoot(cwd);
  if (!repo) throw new Error(`${cwd} is not in a git repository; the lab copies a commit of the project`);
  const revision = await git(["rev-parse", "--verify", `${opts.revision ?? "HEAD"}^{commit}`], repo);
  const domain = detectDomain(repo);
  return {
    id,
    title: title(prompt),
    prompt,
    repo,
    revision,
    domain,
    ...((opts.setup ?? defaultSetup(repo, domain)) ? { setup: opts.setup ?? defaultSetup(repo, domain)! } : {}),
    checks: opts.checks ?? defaultChecks(repo, domain),
    split: "dev",
  };
}

/** The request that opened a session: its first user message without the context block Tropos put in front. */
export function firstPrompt(messages: MessageParam[]): string | null {
  const first = messages.find((m) => m.role === "user");
  if (!first) return null;
  const blocks = typeof first.content === "string" ? [first.content] : first.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  const text = blocks.filter((t) => !t.trimStart().startsWith("<context>")).join("\n").trim();
  return text || null;
}

/** Owner sessions in this project worth replaying (a real request, not a slash command), newest first. */
export async function replayTasks(home: string, cwd: string, opts: { session?: string; recent?: number } & TaskOptions): Promise<LabTask[]> {
  const dir = projectDir(home, cwd);
  const names = opts.session ? [`${opts.session}.jsonl`] : (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl"));
  const found: { id: string; prompt: string; at: string }[] = [];
  for (const name of names) {
    const contents = await readSessionFile(join(dir, name)).catch(() => null);
    if (!contents) {
      if (opts.session) throw new Error(`No session ${opts.session} in ${cwd}`);
      continue;
    }
    // Subagents' transcripts and guests' sessions are not the owner's requests.
    if (contents.meta.parentId || (contents.meta.role && contents.meta.role !== "owner")) continue;
    const prompt = firstPrompt(contents.messages);
    if (!prompt || prompt.length < 20 || prompt.startsWith("/") || prompt.startsWith("<command") || prompt.startsWith("<skill")) continue;
    found.push({ id: name.slice(0, -".jsonl".length), prompt, at: contents.meta.createdAt ?? "" });
  }
  found.sort((a, b) => b.at.localeCompare(a.at));
  const picked = opts.session ? found : found.slice(0, opts.recent ?? 3);
  const tasks: LabTask[] = [];
  for (const s of picked) tasks.push({ ...(await taskFromPrompt(cwd, s.prompt, opts, `session-${s.id.slice(0, 8)}`)), split: "replay" });
  return tasks;
}

/** A task from a JSON file: { prompt, repo?, revision?, setup?, checks?, id?, split? }; repo defaults to `cwd`. */
export async function taskFromFile(path: string, cwd: string): Promise<LabTask> {
  const spec = JSON.parse(await readFile(path, "utf8")) as Partial<LabTask>;
  if (typeof spec.prompt !== "string" || !spec.prompt.trim()) throw new Error(`${path}: "prompt" is required`);
  const task = await taskFromPrompt(spec.repo ?? cwd, spec.prompt, { revision: spec.revision, setup: spec.setup, checks: spec.checks }, spec.id ?? "file");
  return { ...task, ...(spec.split === "holdout" || spec.split === "dev" ? { split: spec.split } : {}) };
}

/** The harness a lab for `scope` starts from: the base with the adopted layers of that scope (and the ones below). */
export async function adoptedTree(home: string, cwd: string, scope: "global" | "project"): Promise<HarnessTree> {
  if (scope === "project") return (await loadHarness({ home, cwd })).tree;
  const global = await readLayer(globalHarnessDir(home));
  const tree = overlay(BASE_TREE, global.tree);
  return validateTree(tree).length === 0 ? tree : BASE_TREE;
}

export interface LabModels {
  /** The executor: the model the probes run. */
  model: string;
  effort: Effort;
  /** The editors', composer's, selector's and reflector's model (default: the executor's; the paper shows that works). */
  editorModel?: string;
}

/** The provider key a probe needs, by its variable's name: the env var or the key saved with /providers. */
export async function probeKey(home: string, model: string, env: NodeJS.ProcessEnv): Promise<{ name: string; value: string } | null> {
  const { provider } = parseModelId(model);
  const name = provider.keyEnv[0];
  if (!name) return null;
  const key = resolveApiKey(provider.keyEnv, provider.id, env, await readCredentials(home));
  return key ? { name, value: key.apiKey } : null;
}

export interface LabSetup {
  home: string;
  env: NodeJS.ProcessEnv;
  /** How to start tcode for a probe. */
  command: string[];
  /** The model provider (the router). */
  router: Model;
  /** Provider settings the probes' fresh home needs. */
  providers?: Record<string, unknown>;
  models: LabModels;
  maxTurns?: number;
  timeoutMs?: number;
}

/** The owner's projects (registered ones and the built-in workspaces): a probe may not read their .env files. */
export async function ownerProjectPaths(home: string): Promise<string[]> {
  const config = await loadGatewayConfig(home).catch(() => null);
  return [...(config?.projects.map((p) => p.path) ?? []), workspaceDir(home), guestWorkspaceDir(home)];
}

export async function labTools(s: LabSetup): Promise<{ runner: ProbeRunner; llm: LlmConfig }> {
  const key = await probeKey(s.home, s.models.model, s.env);
  if (!key) {
    const { provider } = parseModelId(s.models.model);
    throw new Error(`no API key for ${provider.name}: probes run in a fresh home and need ${provider.keyEnv[0] ?? "a key"} or a key saved with /providers`);
  }
  const runner = new LocalProbeRunner({
    command: s.command,
    model: s.models.model,
    effort: s.models.effort,
    maxTurns: s.maxTurns ?? 60,
    timeoutMs: s.timeoutMs ?? 30 * 60_000,
    key,
    ...(s.providers ? { providers: s.providers } : {}),
    ownerHome: s.home,
    otherProjects: await ownerProjectPaths(s.home),
  });
  return { runner, llm: { model: s.router, id: s.models.editorModel ?? s.models.model, effort: s.models.effort } };
}

export interface LabTaskResult {
  run: LabRun;
  reflection: Reflection;
  /** Set when the run's candidate was adopted right away. */
  adopted?: Candidate;
  /** Why an improving candidate was left for the owner. */
  pending?: string;
}

/**
 * Lab, reflection and (with `autoAdopt`) adoption of the candidate when it improved and runs no code. Review
 * suggestions for the same domain and scope join the first step and are marked as tested.
 */
export async function labOnTask(
  task: LabTask,
  o: { home: string; runner: ProbeRunner; llm: LlmConfig; model: string; scope: "global" | "project"; k: number; mode: "parallel" | "sequential"; autoAdopt: boolean; ledger: Ledger; signal: AbortSignal; log?: (line: string) => void },
): Promise<LabTaskResult> {
  const base = await adoptedTree(o.home, task.repo, o.scope);
  // What the layer below the scope holds can be replaced in it, never removed from it.
  const fixed = new Set((o.scope === "project" ? await adoptedTree(o.home, task.repo, "global") : BASE_TREE).keys());
  const suggestions = (await listCandidates(o.home)).filter((c) => c.source === "review" && c.status === "pending" && c.domain === task.domain && c.scope === o.scope);
  const run = await runLab(task, {
    home: o.home,
    runner: o.runner,
    llm: o.llm,
    model: o.model,
    base,
    scope: o.scope,
    // Canonical, as sessions key their project layer (projectHarnessDir of the resolved folder).
    ...(o.scope === "project" ? { project: realpathSync(task.repo) } : {}),
    k: o.k,
    mode: o.mode,
    library: await libraryMaterial(o.home, task.domain),
    fixed,
    suggestions: suggestions.map((s) => ({ id: s.id, rationale: s.rationale, changes: new Map(Object.entries(s.changes)) as Changes })),
    signal: o.signal,
    ...(o.log ? { log: o.log } : {}),
  });
  // Only a run whose reference ran has tested them; otherwise they wait for the next one.
  const tested = run.probes.length > 1 && !run.probes[0]!.error && !o.signal.aborted;
  if (tested) for (const s of suggestions) await saveCandidate(o.home, { ...s, status: "discarded", rationale: `${s.rationale} (tested in lab run ${run.id})` });
  const candidate = run.candidate ? await readCandidate(o.home, run.candidate) : null;
  const finalTree = candidate ? applyChanges(base, new Map(Object.entries(candidate.changes))) : undefined;
  const reflection = await reflect(o.llm, run, { home: o.home, ...(finalTree ? { finalTree } : {}), signal: o.signal });
  const result: LabTaskResult = { run, reflection };
  if (candidate && o.autoAdopt) {
    if (candidateRunsCode(candidate)) result.pending = "it adds scripts, which only the owner adopts";
    // A session's review wrote those rules from a conversation that may quote anything: the owner decides.
    else if (suggestions.length > 0) result.pending = "it was composed with a session review's suggestion, which only the owner adopts";
    // One run each way: fewer steps or tool errors alone may be chance. The checks or checking its work are not.
    else if (!run.verdict.reasons.some((r) => /^(checks passed|checked its work|finished)/.test(r))) result.pending = "it did better only on steps or tool errors, in one run each; worth a look before it is kept";
    else {
      const adopted = await adoptCandidate(o.home, candidate.id, { ledger: o.ledger, actor: "review" });
      if (adopted.ok) result.adopted = adopted.candidate;
      else result.pending = adopted.reason;
    }
  }
  return result;
}

/**
 * The lab on one task with the owner's settings: the session model for the runs, settings.harness for the editors' model,
 * and auto-adoption unless `autoAdopt` is false. The gateway's weekly lab and scheduled jobs use it.
 */
export async function labFromSettings(
  o: { home: string; command: string[]; env: NodeJS.ProcessEnv; settings: Settings; router?: Model },
  task: LabTask,
  run: { k: number; autoAdopt: boolean; signal: AbortSignal; log?: (line: string) => void },
): Promise<LabTaskResult> {
  const { settings } = o;
  const env = { ...o.env, ...settings.env };
  const { runner, llm } = await labTools({
    home: o.home,
    env,
    command: o.command,
    router: o.router ?? new ProviderRouter({ home: o.home, env, settings: settings.providers }),
    providers: settings.providers as Record<string, unknown>,
    models: { model: settings.model, effort: settings.effort, ...(settings.harness.editorModel ? { editorModel: settings.harness.editorModel } : {}) },
  });
  return labOnTask(task, {
    home: o.home,
    runner,
    llm,
    model: settings.model,
    scope: "global",
    k: run.k,
    mode: "parallel",
    autoAdopt: run.autoAdopt && settings.harness.autoAdopt,
    ledger: new Ledger(o.home),
    signal: run.signal,
    ...(run.log ? { log: run.log } : {}),
  });
}
