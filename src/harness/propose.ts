// src/harness/propose.ts — Harness²'s Propose: an invariant and a domain editor each read the reference run and write a
// candidate harness. What they return is checked before anything runs it: only files on their part of the surface,
// no hooks, nothing the threat scan refuses, and the always-on budget kept.
import { scanText } from "../learning/threats";
import type { LlmConfig } from "./llm";
import { complete, extractJson } from "./llm";
import type { LabTask, ProbeResult } from "./probe";
import { DOMAIN_EDITOR, INVARIANT_EDITOR } from "./prompts";
import { MAX_FILE_BYTES, surfaceKind, type SurfaceKind } from "./surface";
import { overlay, validateTree, type HarnessTree } from "./tree";

export type EditorRole = "invariant" | "domain";

/** path → new content, or null to drop the file from the overlay. */
export type Changes = Map<string, string | null>;

const ROLE_KINDS: Record<EditorRole | "composer", ReadonlySet<SurfaceKind>> = {
  invariant: new Set(["always-on", "script", "agent"]),
  domain: new Set(["skill", "always-on"]),
  composer: new Set(["always-on", "skill", "script", "agent"]),
};

/** The always-on files the domain editor may touch: only guardrails.md, for its skills' trigger lines. */
const DOMAIN_ALWAYS_ON = new Set(["guardrails.md"]);

export interface CheckedChanges {
  changes: Changes;
  /** Files left out, with why. */
  rejected: string[];
}

/** The files an editor may write, checked one by one; a budget overrun drops every always-on change. */
export function checkChanges(role: EditorRole | "composer", current: HarnessTree, raw: unknown, fixed: ReadonlySet<string> = new Set()): CheckedChanges {
  const changes: Changes = new Map();
  const rejected: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { changes, rejected: raw === undefined ? [] : ['"files" is not an object'] };
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const kind = surfaceKind(path);
    if (!kind) {
      rejected.push(`${path}: not a harness file`);
      continue;
    }
    if (!ROLE_KINDS[role].has(kind) || (role === "domain" && kind === "always-on" && !DOMAIN_ALWAYS_ON.has(path))) {
      rejected.push(`${path}: not the ${role} editor's to change`);
      continue;
    }
    if (value === null) {
      // A layer only adds and replaces: a file from a layer below it would come back the moment it was adopted.
      if (path === "system.md" || fixed.has(path)) rejected.push(`${path}: comes from a layer below this one; it can be replaced, not removed`);
      else changes.set(path, null);
      continue;
    }
    if (typeof value !== "string") {
      rejected.push(`${path}: content is not text`);
      continue;
    }
    if (Buffer.byteLength(value) > MAX_FILE_BYTES) {
      rejected.push(`${path}: over ${MAX_FILE_BYTES / 1024} KB`);
      continue;
    }
    // Scripts run, so they get the strict scan (nothing downloaded or decoded into a shell).
    const scan = scanText(value, { strict: kind === "script" });
    if (!scan.ok) {
      rejected.push(`${path}: refused by the threat scan (${scan.reason})`);
      continue;
    }
    changes.set(path, value);
  }
  const broken = validateTree(applyChanges(current, changes));
  if (broken.length > 0) {
    for (const path of [...changes.keys()]) {
      if (surfaceKind(path) !== "always-on") continue;
      changes.delete(path);
      rejected.push(`${path}: ${broken.join("; ")}`);
    }
  }
  return { changes, rejected };
}

export function applyChanges(tree: HarnessTree, changes: Changes): HarnessTree {
  const next = new Map(overlay(tree, new Map()));
  for (const [path, value] of changes) {
    if (value === null) next.delete(path);
    else next.set(path, value);
  }
  return next;
}

/** The tree as the editors read it: every file, always-on ones first. */
export function renderTree(tree: HarnessTree): string {
  const order = (path: string) => (surfaceKind(path) === "always-on" ? 0 : 1);
  return [...tree.keys()]
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((path) => `<file path="${path}">\n${tree.get(path)}\n</file>`)
    .join("\n\n");
}

/** What a run did, for the editors, the composer and the reflector: its signals, checks and diff, then its trajectory. */
export function renderProbe(probe: ProbeResult, trajectory: string): string {
  const s = probe.signals;
  const lines = [
    `<run id="${probe.id}">`,
    probe.error ? `The run failed: ${probe.error}` : "",
    `Finished: ${s.endReason ?? "unknown"}; turns ${s.turns}; tool calls ${s.toolCalls} (${s.toolErrors} errors); files written ${s.filesWritten}; checked its work after the last change: ${s.verifiedAfterLastEdit ? "yes" : "no"}; re-read files it wrote: ${s.rereadWritten}`,
    probe.audit ? `Diff: ${probe.audit.files} files, +${probe.audit.insertions} -${probe.audit.deletions}${probe.audit.testFilesEdited.length ? `; edited existing tests in ${probe.audit.testFilesEdited.join(", ")}` : ""}` : "",
    ...probe.checks.map((c) => `Check \`${c.command}\`: ${c.ok ? "passed" : `failed${c.timedOut ? " (timed out)" : ""}`}${c.ok ? "" : `\n${c.tail.slice(-1_500)}`}`),
    `Final answer: ${probe.finalText || "(none)"}`,
    "<trajectory>",
    trajectory,
    "</trajectory>",
    "</run>",
  ];
  return lines.filter(Boolean).join("\n");
}

export interface Proposal {
  role: EditorRole;
  observations: string[];
  rationale: string;
  changes: Changes;
  rejected: string[];
  costUsd: number | undefined;
  /** Set when the editor's answer couldn't be used at all. */
  error?: string;
}

export interface ProposeInput {
  task: LabTask;
  /** The harness the reference ran with (base plus overlays). */
  tree: HarnessTree;
  reference: ProbeResult;
  referenceTrajectory: string;
  /** Lessons and earlier harnesses from the library for this domain; empty when there are none. */
  library: string;
  /** Files of the layers below the one being changed: they can be replaced, never removed. */
  fixed?: ReadonlySet<string>;
}

export function editorPrompt(input: ProposeInput): string {
  return [
    `<task domain="${input.task.domain}">\n${input.task.prompt}\n</task>`,
    `<harness>\n${renderTree(input.tree)}\n</harness>`,
    input.library ? `<library>\n${input.library}\n</library>` : "",
    `<reference>\n${renderProbe(input.reference, input.referenceTrajectory)}\n</reference>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function propose(llm: LlmConfig, role: EditorRole, input: ProposeInput, signal: AbortSignal): Promise<Proposal> {
  const system = role === "invariant" ? INVARIANT_EDITOR : DOMAIN_EDITOR;
  let costUsd: number | undefined;
  try {
    const reply = await complete(llm, system, editorPrompt(input), signal);
    costUsd = reply.costUsd;
    const json = extractJson(reply.text);
    const checked = checkChanges(role, input.tree, json.files, input.fixed);
    return {
      role,
      observations: strings(json.observations),
      rationale: typeof json.rationale === "string" ? json.rationale : "",
      changes: checked.changes,
      rejected: checked.rejected,
      costUsd,
    };
  } catch (err) {
    return { role, observations: [], rationale: "", changes: new Map(), rejected: [], costUsd, error: (err as Error).message };
  }
}
