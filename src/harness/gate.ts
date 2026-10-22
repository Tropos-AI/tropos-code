// src/harness/gate.ts — whether a harness did better than the reference on the same task: decided by code, never by a
// model. The project's own checks come first; a run that weakened tests is invalid whatever it scored; then how the
// agent worked (checked its work, tool errors, steps) decides between runs the checks can't tell apart.
import { weakenedTests } from "./audit";
import type { ProbeResult } from "./probe";

export type Outcome = "better" | "same" | "worse" | "invalid";

export interface Verdict {
  outcome: Outcome;
  /** One line per difference that counted, each naming both runs' values. */
  reasons: string[];
}

export const checksPassed = (p: ProbeResult): number => p.checks.filter((c) => c.ok).length;

/** Fewer steps count only past this share; small differences are noise. */
const TURN_GAIN = 0.85;
const TURN_LOSS = 1.25;

/**
 * How a run may end and still be compared: on its own (end_turn), or at a limit the agent ran into itself. A timeout,
 * a crash, an API error or an abort says something about the machine, not the harness: with timeouts common under
 * emulation, "finished where the reference timed out" would adopt chance.
 */
const COMPARABLE_ENDS: ReadonlySet<string> = new Set(["end_turn", "max_turns", "max_tokens", "refusal", "context_exceeded"]);

export function endedOnItsOwn(p: ProbeResult): boolean {
  return p.signals.endReason !== null && COMPARABLE_ENDS.has(p.signals.endReason);
}

export function compareProbes(reference: ProbeResult, candidate: ProbeResult): Verdict {
  if (candidate.error) return { outcome: "invalid", reasons: [`${candidate.id} failed to run: ${candidate.error}`] };
  for (const p of [reference, candidate]) {
    if (!endedOnItsOwn(p)) return { outcome: "invalid", reasons: [`${p.id} didn't finish on its own (${p.signals.endReason ?? "no end"}): nothing to compare`] };
  }
  if (candidate.audit && weakenedTests(candidate.audit)) {
    const where = [...candidate.audit.testFilesEdited, ...candidate.audit.focusMarkers].slice(0, 3).join("; ");
    return { outcome: "invalid", reasons: [`${candidate.id} weakened tests (${where})`] };
  }
  const better: string[] = [];
  const worse: string[] = [];
  const [r, c] = [reference.signals, candidate.signals];
  const [rc, cc] = [checksPassed(reference), checksPassed(candidate)];
  if (cc > rc) better.push(`checks passed ${rc} → ${cc}`);
  if (cc < rc) worse.push(`checks passed ${rc} → ${cc}`);
  if (r.endReason === "end_turn" && c.endReason !== "end_turn") worse.push(`finished with ${c.endReason ?? "nothing"} instead of end_turn`);
  if (r.endReason !== "end_turn" && c.endReason === "end_turn") better.push(`finished (end_turn) where the reference stopped at ${r.endReason}`);
  if (c.verifiedAfterLastEdit && !r.verifiedAfterLastEdit) better.push("checked its work after the last change; the reference didn't");
  if (!c.verifiedAfterLastEdit && r.verifiedAfterLastEdit) worse.push("didn't check its work after the last change; the reference did");
  if (c.toolErrors < r.toolErrors) better.push(`tool errors ${r.toolErrors} → ${c.toolErrors}`);
  if (c.toolErrors > r.toolErrors + 1) worse.push(`tool errors ${r.toolErrors} → ${c.toolErrors}`);
  if (r.turns > 0 && c.turns <= r.turns * TURN_GAIN) better.push(`turns ${r.turns} → ${c.turns}`);
  if (r.turns > 0 && c.turns > r.turns * TURN_LOSS) worse.push(`turns ${r.turns} → ${c.turns}`);
  // The checks outrank everything else: more passing checks with more steps is still better, fewer is still worse.
  if (cc !== rc) return { outcome: cc > rc ? "better" : "worse", reasons: [...better, ...worse] };
  const outcome: Outcome = better.length > 0 && worse.length === 0 ? "better" : worse.length > 0 && better.length === 0 ? "worse" : "same";
  return { outcome, reasons: [...better, ...worse] };
}

/** Orders runs best first: valid before invalid, then checks, finished, checked, tool errors, turns. */
export function rankProbes(probes: ProbeResult[]): ProbeResult[] {
  const key = (p: ProbeResult): number[] => [
    p.error || (p.audit && weakenedTests(p.audit)) || !endedOnItsOwn(p) ? 0 : 1,
    checksPassed(p),
    p.signals.endReason === "end_turn" ? 1 : 0,
    p.signals.verifiedAfterLastEdit ? 1 : 0,
    -p.signals.toolErrors,
    -p.signals.turns,
  ];
  return [...probes].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!;
    return 0;
  });
}
