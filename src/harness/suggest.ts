// src/harness/suggest.ts — the background review's way into the harness: it may suggest a few standing rules in its
// reply, and they become an untested candidate. Nothing uses them until the harness lab has run them against the
// current harness on real tasks (they join its next run as a proposal of their own).
import { scanText } from "../learning/threats";
import { saveCandidate, newId, type Candidate } from "./candidates";
import { detectDomain } from "./domain";
import { adoptedTree } from "./service";
import { validateTree } from "./tree";

export const HARNESS_SUGGESTION_RULES =
  "Harness suggestions: if the conversation above shows a mistake in how you work — how you used tools, checked your work, planned or delegated — " +
  "that a short standing rule would have prevented, and that would recur on other tasks (not a fact about this project or user: those go to memory), " +
  "you may suggest at most three such rules at the very end of your reply, as:\n" +
  '```harness-suggestion\n{"rationale": "what in the conversation shows it", "rules": ["one rule per line"]}\n```\n' +
  "They are never used as written: they are tested on real tasks first and kept only if they measurably help. Leave it out when there is no such evidence.";

const BLOCK = /```harness-suggestion\s*\n([\s\S]*?)\n```/;
const MAX_RULES = 3;
const MAX_RULE_CHARS = 300;

export interface Suggestion {
  rationale: string;
  rules: string[];
}

/** The suggestion in a review's reply, rules cleaned to single lines; null when there is none or it is malformed. */
export function parseSuggestion(reply: string): Suggestion | null {
  const body = BLOCK.exec(reply)?.[1];
  if (!body) return null;
  try {
    const json = JSON.parse(body) as { rationale?: unknown; rules?: unknown };
    const rules = (Array.isArray(json.rules) ? json.rules : [])
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.replace(/\s+/g, " ").trim())
      .filter((r) => r.length > 0 && r.length <= MAX_RULE_CHARS)
      .slice(0, MAX_RULES);
    if (rules.length === 0) return null;
    return { rationale: typeof json.rationale === "string" ? json.rationale.replace(/\s+/g, " ").trim() : "", rules };
  } catch {
    return null;
  }
}

/**
 * Saves the suggestion as a pending, untested candidate for every project: the current guardrails.md with the rules
 * appended. Rules the threat scan refuses are dropped; returns the candidate, or null when nothing was left.
 */
export async function saveSuggestion(home: string, cwd: string, session: { id: string; title?: string }, suggestion: Suggestion, now: Date = new Date()): Promise<Candidate | null> {
  const rules = suggestion.rules.filter((r) => scanText(r).ok);
  if (rules.length === 0) return null;
  // The candidate is for every project, so it builds on the adopted global layer only, never on this project's.
  const current = (await adoptedTree(home, cwd, "global")).get("guardrails.md") ?? "";
  const guardrails = `${current.trimEnd()}${current.trim() ? "\n" : ""}${rules.map((r) => `- ${r}`).join("\n")}\n`;
  // The whole file it would write, not only the new lines: that is what a session would read. And it must fit, or
  // adopting it would make sessions skip the whole global layer.
  if (!scanText(guardrails).ok) return null;
  const global = await adoptedTree(home, cwd, "global");
  if (validateTree(new Map([...global, ["guardrails.md", guardrails]])).length > 0) return null;
  const candidate: Candidate = {
    id: newId(now),
    createdAt: now.toISOString(),
    source: "review",
    scope: "global",
    domain: detectDomain(cwd),
    task: { id: session.id, title: session.title ?? "a session" },
    changes: { "guardrails.md": guardrails },
    rationale: scanText(suggestion.rationale).ok ? suggestion.rationale : "",
    status: "pending",
  };
  await saveCandidate(home, candidate);
  return candidate;
}
