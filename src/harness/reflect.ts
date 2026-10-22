// src/harness/reflect.ts — Harness²'s reflector: after a lab run, keep what it taught. Lessons must cite runs the lab
// made (a contrast, not an opinion), pass the threat scan, and say nothing about what the hidden checks wanted. Holdout
// tasks are only ever measured: nothing they show reaches the library.
import { scanText } from "../learning/threats";
import { supportedLessons, type Confidence, type Lesson } from "./experience";
import type { LabRun } from "./lab";
import { overlayOf } from "./lab";
import { addEntry } from "./library";
import { complete, extractJson, type LlmConfig } from "./llm";
import { REFLECTOR } from "./prompts";
import type { HarnessTree } from "./tree";

/** A lesson about the grader or the hidden checks would teach the harness the test, not the method. */
const GRADER = /\b(hidden tests?|grader|graded|hidden checks?|ground truth|holdout)\b/i;

export function reflectorPrompt(run: LabRun): string {
  const probes = run.probes.map((p) => {
    const s = p.signals;
    const checks = p.checks.map((c) => `${c.command}: ${c.ok ? "passed" : "failed"}`).join("; ");
    return `- run ${p.id} (${p.label}): ${p.error ? `failed: ${p.error}` : `${checks || "no checks"}; ${s.turns} turns; ${s.toolErrors} tool errors; checked its work: ${s.verifiedAfterLastEdit ? "yes" : "no"}; finished: ${s.endReason}`}; harness files: ${p.harness.join(", ") || "built-in"}`;
  });
  const proposals = run.proposals.map((p) => `- ${p.label} (${p.role}): ${p.error ? `unusable: ${p.error}` : p.rationale} [files: ${p.files.join(", ") || "none"}]`);
  const decisions = run.compositions.flatMap((c) => c.decisions.map((d) => `- ${c.label}: ${d.decision} (${d.evidence})`));
  return [
    `<task domain="${run.task.domain}">${run.task.title}</task>`,
    `<runs>\n${probes.join("\n")}\n</runs>`,
    `<proposals>\n${proposals.join("\n") || "(none)"}\n</proposals>`,
    `<decisions>\n${decisions.join("\n") || "(none)"}\n</decisions>`,
    `<verdict outcome="${run.verdict.outcome}">\n${run.verdict.reasons.join("\n")}\n</verdict>`,
  ].join("\n\n");
}

const CONFIDENCE: readonly string[] = ["high", "medium", "low"];

function lessonsFrom(raw: unknown): Lesson[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) => {
    const o = l as Record<string, unknown> | null;
    if (!o || typeof o.title !== "string" || typeof o.cue !== "string" || typeof o.lesson !== "string" || !Array.isArray(o.evidence)) return [];
    const confidence = typeof o.confidence === "string" && CONFIDENCE.includes(o.confidence) ? (o.confidence as Confidence) : "low";
    const evidence = o.evidence.filter((e): e is string => typeof e === "string");
    // One line each: a newline would break EXPERIENCE.md's sections.
    const line = (s: string) => s.replace(/\s+/g, " ").trim();
    return [{ title: line(o.title), for: o.for === "agent" ? ("agent" as const) : ("editor" as const), cue: line(o.cue), lesson: line(o.lesson), evidence: evidence.map(line), confidence }];
  });
}

/** Lessons that survive every check, and why the others didn't. */
export function keepLessons(lessons: Lesson[], run: LabRun): { kept: Lesson[]; dropped: string[] } {
  const dropped: string[] = [];
  const supported = supportedLessons(lessons, new Set(run.probes.map((p) => p.id)));
  for (const l of lessons) if (!supported.some((s) => s.title === l.title)) dropped.push(`${l.title}: cites no run of this lab`);
  const kept = supported.filter((l) => {
    const text = [l.title, l.cue, l.lesson, ...l.evidence].join("\n");
    if (GRADER.test(text)) {
      dropped.push(`${l.title}: about the grader or hidden checks`);
      return false;
    }
    const scan = scanText(text);
    if (!scan.ok) {
      dropped.push(`${l.title}: refused by the threat scan (${scan.reason})`);
      return false;
    }
    return true;
  });
  return { kept, dropped };
}

export interface Reflection {
  lessons: Lesson[];
  dropped: string[];
  /** Whether a library entry was written. */
  stored: boolean;
  costUsd: number | undefined;
  error?: string;
}

/**
 * Reflects on `run` and stores an entry in its domain's library when there is something to keep: lessons, or a harness
 * that did better. `finalTree` is the harness the run ended on (the selected composition), when it changed.
 */
export async function reflect(llm: LlmConfig, run: LabRun, opts: { home: string; finalTree?: HarnessTree; signal: AbortSignal }): Promise<Reflection> {
  if (run.task.split === "holdout") return { lessons: [], dropped: [], stored: false, costUsd: 0, error: "holdout tasks are never learned from" };
  if (run.verdict.outcome === "invalid" && run.probes.length <= 1) return { lessons: [], dropped: [], stored: false, costUsd: 0, error: "the reference didn't run" };
  let costUsd: number | undefined;
  try {
    const reply = await complete(llm, REFLECTOR, reflectorPrompt(run), opts.signal);
    costUsd = reply.costUsd;
    const { kept, dropped } = keepLessons(lessonsFrom(extractJson(reply.text).lessons), run);
    const harness = run.verdict.outcome === "better" && opts.finalTree ? overlayOf(opts.finalTree) : new Map<string, string>();
    if (kept.length === 0 && harness.size === 0) return { lessons: [], dropped, stored: false, costUsd };
    await addEntry(
      opts.home,
      {
        id: run.id,
        domain: run.task.domain,
        task: { id: run.task.id, title: run.task.title },
        outcome: run.verdict.outcome,
        files: [...harness.keys()].sort(),
        lessons: kept.length,
        createdAt: run.finishedAt ?? run.startedAt,
      },
      { harness, lessons: kept },
    );
    return { lessons: kept, dropped, stored: true, costUsd };
  } catch (err) {
    return { lessons: [], dropped: [], stored: false, costUsd, error: (err as Error).message };
  }
}
