// src/harness/compose.ts — Harness²'s Compose and Select. The composer reads the reference run, both proposals, their
// diffs and their runs, and writes the next harness, every decision tied to a run. The selector picks one deliverable
// among several runs without knowing which harness produced which.
import { renderTreeDiff, type HarnessTree } from "./tree";
import { complete, extractJson, type LlmConfig } from "./llm";
import type { LabTask, ProbeResult } from "./probe";
import { applyChanges, checkChanges, renderProbe, renderTree, type Changes, type Proposal } from "./propose";
import { COMPOSER, SELECTOR } from "./prompts";

export interface Decision {
  decision: string;
  evidence: string;
}

export interface Composition {
  decisions: Decision[];
  rationale: string;
  changes: Changes;
  rejected: string[];
  costUsd: number | undefined;
  error?: string;
}

export interface ComposeInput {
  task: LabTask;
  tree: HarnessTree;
  reference: ProbeResult;
  referenceTrajectory: string;
  candidates: { proposal: Proposal; probe: ProbeResult | null; trajectory: string }[];
}

export function composerPrompt(input: ComposeInput): string {
  const parts = [
    `<task domain="${input.task.domain}">\n${input.task.prompt}\n</task>`,
    `<reference-harness>\n${renderTree(input.tree)}\n</reference-harness>`,
    `<reference>\n${renderProbe(input.reference, input.referenceTrajectory)}\n</reference>`,
  ];
  for (const c of input.candidates) {
    const diff = renderTreeDiff(input.tree, applyChanges(input.tree, c.proposal.changes));
    parts.push(
      [
        `<proposal editor="${c.proposal.role}">`,
        c.proposal.error ? `The editor's answer was unusable: ${c.proposal.error}` : `Rationale: ${c.proposal.rationale}`,
        c.proposal.observations.length ? `Observations:\n${c.proposal.observations.map((o) => `- ${o}`).join("\n")}` : "",
        `<diff>\n${diff || "(no changes)"}\n</diff>`,
        c.probe ? renderProbe(c.probe, c.trajectory) : "(not run: it changed nothing)",
        "</proposal>",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return parts.join("\n\n");
}

const decisions = (v: unknown): Decision[] =>
  Array.isArray(v)
    ? v.flatMap((d) => {
        const o = d as { decision?: unknown; evidence?: unknown } | null;
        return o && typeof o.decision === "string" ? [{ decision: o.decision, evidence: typeof o.evidence === "string" ? o.evidence : "" }] : [];
      })
    : [];

export async function compose(llm: LlmConfig, input: ComposeInput, signal: AbortSignal): Promise<Composition> {
  let costUsd: number | undefined;
  try {
    const reply = await complete(llm, COMPOSER, composerPrompt(input), signal);
    costUsd = reply.costUsd;
    const json = extractJson(reply.text);
    const checked = checkChanges("composer", input.tree, json.files);
    return { decisions: decisions(json.decisions), rationale: typeof json.rationale === "string" ? json.rationale : "", changes: checked.changes, rejected: checked.rejected, costUsd };
  } catch (err) {
    return { decisions: [], rationale: "", changes: new Map(), rejected: [], costUsd, error: (err as Error).message };
  }
}

export interface Selection {
  /** The chosen probe's id. */
  id: string;
  reason: string;
  costUsd: number | undefined;
}

const LETTERS = "ABCDEFGHIJ";

/** The runs as the selector sees them: letters for names, outcome and diff, no harness. */
export function selectorPrompt(task: LabTask, options: { probe: ProbeResult; patch: string }[]): string {
  return [
    `<task>\n${task.prompt}\n</task>`,
    ...options.map(({ probe, patch }, i) =>
      [
        `<attempt label="${LETTERS[i]}">`,
        ...probe.checks.map((c) => `Check \`${c.command}\`: ${c.ok ? "passed" : "failed"}`),
        probe.audit?.testFilesEdited.length ? `Edited existing tests: ${probe.audit.testFilesEdited.join(", ")}` : "",
        `Final answer: ${probe.finalText || "(none)"}`,
        `<patch>\n${patch.length > 12_000 ? `${patch.slice(0, 12_000)}\n… [patch cut]` : patch}\n</patch>`,
        "</attempt>",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n\n");
}

/** Picks among runs; a single run, or an answer that names no run, falls back to the first (best-ranked) one. */
export async function select(llm: LlmConfig, task: LabTask, options: { probe: ProbeResult; patch: string }[], signal: AbortSignal): Promise<Selection> {
  const first = options[0]!.probe.id;
  if (options.length === 1) return { id: first, reason: "the only valid run", costUsd: 0 };
  let costUsd: number | undefined;
  try {
    const reply = await complete(llm, SELECTOR, selectorPrompt(task, options.slice(0, LETTERS.length)), signal);
    costUsd = reply.costUsd;
    const json = extractJson(reply.text);
    const index = typeof json.choice === "string" ? LETTERS.indexOf(json.choice.trim().toUpperCase()) : -1;
    const reason = typeof json.reason === "string" ? json.reason : "";
    return index >= 0 && index < options.length ? { id: options[index]!.probe.id, reason, costUsd } : { id: first, reason: `fallback: the selector named no attempt (${reason})`, costUsd };
  } catch (err) {
    return { id: first, reason: `fallback: ${(err as Error).message}`, costUsd };
  }
}
