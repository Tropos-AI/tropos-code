// src/harness/lab.ts — one harness lab run on one task (Harness²'s task level): run the task with the current harness
// (the reference), let the invariant and the domain editor each propose a harness, run both, compose the next harness
// from what the runs showed, run that, and keep it as a candidate only if the gate says it did better. With k > 1,
// "parallel" makes k independent compositions and a selector picks one; "sequential" chains k steps, each built on
// the last one that improved. Everything is kept under ~/.tropos/harness/lab/<run>/ for the reflector and the owner.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addCost, type LlmConfig } from "./llm";
import { BASE_TREE } from "./base";
import { newId, saveCandidate, type Candidate } from "./candidates";
import { compose, select, type Composition } from "./compose";
import { compareProbes, rankProbes, type Verdict } from "./gate";
import type { LabTask, ProbeResult, ProbeRunner } from "./probe";
import { applyChanges, propose, type Changes, type EditorRole, type Proposal } from "./propose";
import { parseTrajectory, renderTrajectory } from "./signals";
import { diffTrees, harnessRoot, type HarnessTree } from "./tree";

export interface LabOptions {
  home: string;
  runner: ProbeRunner;
  /** The editors', composer's and selector's model. */
  llm: LlmConfig;
  /** The executor's model id, for the record. */
  model: string;
  /** The harness the reference runs with: the built-in base with the layers adopted for this scope. */
  base: HarnessTree;
  scope: "global" | "project";
  /** For scope "project": the project's folder. */
  project?: string;
  k: number;
  mode: "parallel" | "sequential";
  /** Library material for the editors (lessons and earlier harnesses of this domain). */
  library: string;
  /** Files of the layers below the scope's (the base, and for a project the global layer): never removed. */
  fixed?: ReadonlySet<string>;
  /** Untested changes a session's review suggested: run and composed like a third proposal. */
  suggestions?: { id: string; changes: Changes; rationale: string }[];
  signal: AbortSignal;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface ProposalRecord {
  label: string;
  role: EditorRole | "suggestion";
  rationale: string;
  observations: string[];
  files: string[];
  rejected: string[];
  error?: string;
}

export interface CompositionRecord {
  label: string;
  decisions: { decision: string; evidence: string }[];
  rationale: string;
  files: string[];
  rejected: string[];
  error?: string;
}

export interface LabRun {
  id: string;
  task: LabTask;
  scope: "global" | "project";
  project?: string;
  k: number;
  mode: "parallel" | "sequential";
  model: string;
  editorModel: string;
  startedAt: string;
  finishedAt?: string;
  probes: ProbeResult[];
  proposals: ProposalRecord[];
  compositions: CompositionRecord[];
  /** The final run the verdict is about, and why the selector chose it (k > 1). */
  selected?: { id: string; reason: string };
  verdict: Verdict;
  /** The candidate written when the verdict was "better". */
  candidate?: string;
  /** Editors, composer, selector and every probe together; null when none of them reported a cost. */
  costUsd: number | null;
}

export function labDir(home: string, runId?: string): string {
  return runId ? join(harnessRoot(home), "lab", runId) : join(harnessRoot(home), "lab");
}

/** The files of `tree` that differ from the built-in base: what a probe's --harness-dir holds. */
export function overlayOf(tree: HarnessTree): Map<string, string> {
  return new Map([...tree].filter(([path, text]) => BASE_TREE.get(path) !== text));
}

export async function writeOverlay(dir: string, tree: HarnessTree): Promise<string[]> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const files = overlayOf(tree);
  for (const [path, text] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, path), text, { mode: 0o600 });
  }
  return [...files.keys()].sort();
}

interface Ran {
  tree: HarnessTree;
  probe: ProbeResult;
  trajectory: string;
}

export async function runLab(task: LabTask, opts: LabOptions): Promise<LabRun> {
  const now = opts.now ?? (() => new Date());
  const id = newId(now());
  const root = labDir(opts.home, id);
  const log = opts.log ?? (() => {});
  const run: LabRun = {
    id,
    task,
    scope: opts.scope,
    ...(opts.project ? { project: opts.project } : {}),
    k: opts.k,
    mode: opts.mode,
    model: opts.model,
    editorModel: opts.llm.id,
    startedAt: now().toISOString(),
    probes: [],
    proposals: [],
    compositions: [],
    verdict: { outcome: "same", reasons: [] },
    costUsd: null,
  };
  let cost: number | undefined;
  const spend = (c: number | undefined | null) => void (cost = addCost(cost, c ?? undefined));
  const save = async () => {
    run.costUsd = cost ?? null;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "run.json"), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  };

  const probeTree = async (tree: HarnessTree, label: string): Promise<Ran> => {
    // A stopped lab starts nothing new.
    opts.signal.throwIfAborted();
    const dir = join(root, label);
    const harnessDir = join(dir, "harness");
    const harnessFiles = await writeOverlay(harnessDir, tree);
    log(`probe ${label}: running ${task.id} with ${harnessFiles.length ? harnessFiles.join(", ") : "the built-in harness"}`);
    const probe = await opts.runner.run({ task, harnessDir, dir, id: `${id}-${label}`, label, harnessFiles }, opts.signal);
    spend(probe.signals.costUsd);
    run.probes.push(probe);
    const trajectory = renderTrajectory(parseTrajectory(await readFile(join(dir, "trajectory.jsonl"), "utf8").catch(() => "")));
    log(`probe ${label}: ${probe.error ? `failed: ${probe.error}` : `${probe.checks.filter((c) => c.ok).length}/${probe.checks.length} checks, ${probe.signals.turns} turns, ${probe.signals.toolErrors} tool errors`}`);
    await save();
    return { tree, probe, trajectory };
  };

  /** One Propose–Probe–Compose step on top of `from`; the composed run, or `from` itself when nothing changed. */
  const step = async (from: Ran, i: number): Promise<Ran> => {
    const input = { task, tree: from.tree, reference: from.probe, referenceTrajectory: from.trajectory, library: opts.library, fixed: opts.fixed ?? new Set(BASE_TREE.keys()) };
    const [inv, dom] = await Promise.all((["invariant", "domain"] as const).map((role) => propose(opts.llm, role, input, opts.signal)));
    const proposals: { label: string; proposal: Proposal; role: EditorRole | "suggestion" }[] = [
      { label: `inv-${i}`, proposal: inv!, role: "invariant" },
      { label: `dom-${i}`, proposal: dom!, role: "domain" },
      ...(i === 1 ? (opts.suggestions ?? []) : []).map((s, j) => ({
        label: `sug-${j + 1}`,
        role: "suggestion" as const,
        proposal: { role: "invariant" as const, observations: [], rationale: `${s.rationale} (suggested by a session's review, ${s.id})`, changes: s.changes, rejected: [], costUsd: 0 },
      })),
    ];
    const candidates: { proposal: Proposal; probe: ProbeResult | null; trajectory: string }[] = [];
    for (const p of proposals) {
      spend(p.proposal.costUsd);
      run.proposals.push({ label: p.label, role: p.role, rationale: p.proposal.rationale, observations: p.proposal.observations, files: [...p.proposal.changes.keys()], rejected: p.proposal.rejected, ...(p.proposal.error ? { error: p.proposal.error } : {}) });
      // A proposal that changes nothing would only repeat the reference run.
      const ran = p.proposal.changes.size > 0 ? await probeTree(applyChanges(from.tree, p.proposal.changes), p.label) : null;
      candidates.push({ proposal: p.proposal, probe: ran?.probe ?? null, trajectory: ran?.trajectory ?? "" });
    }
    const composition: Composition = await compose(opts.llm, { ...input, candidates }, opts.signal);
    spend(composition.costUsd);
    const label = `comp-${i}`;
    run.compositions.push({ label, decisions: composition.decisions, rationale: composition.rationale, files: [...composition.changes.keys()], rejected: composition.rejected, ...(composition.error ? { error: composition.error } : {}) });
    await save();
    if (composition.changes.size === 0) return from;
    return probeTree(applyChanges(from.tree, composition.changes), label);
  };

  try {
    const reference = await probeTree(opts.base, "ref");
    if (reference.probe.error) {
      run.verdict = { outcome: "invalid", reasons: [`the reference run failed: ${reference.probe.error}`] };
      return run;
    }
    const finals: Ran[] = [];
    if (opts.mode === "parallel") {
      for (let i = 1; i <= opts.k; i++) finals.push(await step(reference, i));
    } else {
      let current = reference;
      for (let i = 1; i <= opts.k; i++) {
        const next = await step(current, i);
        // Each step builds on the last one that improved on its own starting point.
        if (next !== current && compareProbes(current.probe, next.probe).outcome === "better") current = next;
      }
      finals.push(current);
    }
    const improved = finals.filter((f) => f !== reference && compareProbes(reference.probe, f.probe).outcome === "better");
    if (improved.length === 0) {
      const best = rankProbes(finals.filter((f) => f !== reference).map((f) => f.probe))[0];
      run.verdict = best ? compareProbes(reference.probe, best) : { outcome: "same", reasons: ["no proposal changed the harness"] };
      if (best) run.selected = { id: best.id, reason: "best-ranked composition (not adopted)" };
      return run;
    }
    const ranked = rankProbes(improved.map((f) => f.probe));
    const options = await Promise.all(ranked.map(async (probe) => ({ probe, patch: await readFile(join(root, probe.label, "patch.diff"), "utf8").catch(() => "") })));
    const selection = await select(opts.llm, task, options, opts.signal);
    spend(selection.costUsd);
    const chosen = improved.find((f) => f.probe.id === selection.id) ?? improved[0]!;
    opts.signal.throwIfAborted();
    run.selected = { id: chosen.probe.id, reason: selection.reason };
    run.verdict = compareProbes(reference.probe, chosen.probe);
    const changes = Object.fromEntries(diffTrees(opts.base, chosen.tree).map((d) => [d.path, d.change === "removed" ? null : chosen.tree.get(d.path)!]));
    const composition = run.compositions.find((c) => `${id}-${c.label}` === chosen.probe.id);
    const candidate: Candidate = {
      id,
      createdAt: now().toISOString(),
      source: "lab",
      runId: id,
      scope: opts.scope,
      ...(opts.project ? { project: opts.project } : {}),
      domain: task.domain,
      task: { id: task.id, title: task.title },
      changes,
      verdict: run.verdict,
      rationale: composition?.rationale ?? "",
      decisions: composition?.decisions ?? [],
      status: "pending",
    };
    await saveCandidate(opts.home, candidate);
    run.candidate = id;
    return run;
  } catch (err) {
    if (!opts.signal.aborted) throw err;
    run.verdict = { outcome: "invalid", reasons: ["the lab was stopped before it finished"] };
    return run;
  } finally {
    run.finishedAt = now().toISOString();
    await save();
    log(`lab ${id}: ${run.verdict.outcome}${run.candidate ? `, candidate ${run.candidate}` : ""}`);
  }
}

export async function readLabRun(home: string, id: string): Promise<LabRun | null> {
  try {
    return JSON.parse(await readFile(join(labDir(home, id), "run.json"), "utf8")) as LabRun;
  } catch {
    return null;
  }
}

/** Deletes a run's probe folders but keeps run.json: the trajectories are what take the room. */
export async function pruneLabRun(home: string, id: string): Promise<void> {
  const run = await readLabRun(home, id);
  if (!run) return;
  for (const probe of run.probes) await rm(join(labDir(home, id), probe.label), { recursive: true, force: true });
}
