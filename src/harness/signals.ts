// src/harness/signals.ts — what a probe's trajectory shows about how the agent worked (Harness²'s "behavioural
// contrast"): did it check its work, re-read what it wrote, hit tool errors, and how many steps it took. These are the
// signals the composer reads next to the repository's own verifiers.

/** A stream-json line of `tcode -p --output-format stream-json`, as parsed JSON. */
export type TrajectoryEvent = { type: string } & Record<string, unknown>;

export interface BehaviourSignals {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  /** Files changed with Write or Edit. */
  filesWritten: number;
  /** A test, type-check, lint or build command ran after the last change. */
  verifiedAfterLastEdit: boolean;
  /** Written files the agent read again after writing them. */
  rereadWritten: number;
  endReason: string | null;
  costUsd: number | null;
}

const WRITE_TOOLS = new Set(["Write", "Edit"]);
/** Commands that check work; matched against the start of each shell segment. */
const VERIFY = /(^|[;&|(]\s*|\s)(bun (run )?test|bun x tsc|npx tsc|tsc\b|npm (run )?(test|build|lint|typecheck)|pnpm (run )?(test|build|lint|typecheck)|yarn (test|build|lint|typecheck)|bun run (build|lint|typecheck)|pytest|python -m (pytest|unittest)|cargo (test|check|build|clippy)|go (test|vet|build)|make (test|check)|ruff|mypy|eslint|vitest|jest)\b/;

export function isVerifyCommand(command: string): boolean {
  return VERIFY.test(command);
}

function pathOf(input: unknown): string | undefined {
  const value = (input as { file_path?: unknown } | null)?.file_path;
  return typeof value === "string" ? value : undefined;
}

export function parseTrajectory(stdout: string): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") events.push(value as TrajectoryEvent);
    } catch {
      // not an event line
    }
  }
  return events;
}

export function behaviourSignals(events: TrajectoryEvent[]): BehaviourSignals {
  const signals: BehaviourSignals = { turns: 0, toolCalls: 0, toolErrors: 0, filesWritten: 0, verifiedAfterLastEdit: false, rereadWritten: 0, endReason: null, costUsd: null };
  const starts = new Map<string, { name: string; input: unknown }>();
  const written = new Set<string>();
  const reread = new Set<string>();
  let editedSinceVerify = false;
  let everVerified = false;
  for (const e of events) {
    if (e.type === "assistant") signals.turns++;
    else if (e.type === "tool_start") starts.set(String(e.id), { name: String(e.name), input: e.input });
    else if (e.type === "tool_end") {
      signals.toolCalls++;
      if (e.status === "error") signals.toolErrors++;
      const start = starts.get(String(e.id));
      if (!start || e.status !== "done") continue;
      const path = pathOf(start.input);
      if (WRITE_TOOLS.has(start.name) && path) {
        written.add(path);
        editedSinceVerify = true;
      } else if (start.name === "Read" && path && written.has(path)) reread.add(path);
      else if (start.name === "Bash") {
        const command = (start.input as { command?: unknown } | null)?.command;
        if (typeof command === "string" && isVerifyCommand(command)) {
          editedSinceVerify = false;
          everVerified = true;
        }
      }
    } else if (e.type === "turn_end") signals.endReason = String(e.reason);
    else if (e.type === "usage" && typeof e.totalCostUsd === "number") signals.costUsd = e.totalCostUsd;
  }
  signals.filesWritten = written.size;
  signals.rereadWritten = reread.size;
  signals.verifiedAfterLastEdit = everVerified && !editedSinceVerify;
  return signals;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more]` : text);

function toolOutputText(output: unknown): string {
  const content = (output as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : "")).join("");
  return "";
}

/**
 * A compact, readable trajectory for the editors and the composer: the agent's words and every tool call with a clipped
 * input and result. Whatever the trajectory quotes (files, web pages, command output) is data, never instructions.
 */
export function renderTrajectory(events: TrajectoryEvent[], maxChars = 40_000): string {
  const lines: string[] = [];
  const starts = new Map<string, { name: string; input: unknown }>();
  for (const e of events) {
    if (e.type === "assistant") {
      const content = Array.isArray(e.content) ? (e.content as Array<{ type?: string; text?: string }>) : [];
      const text = content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("").trim();
      if (text) lines.push(`ASSISTANT: ${clip(text, 1_500)}`);
    } else if (e.type === "tool_start") {
      starts.set(String(e.id), { name: String(e.name), input: e.input });
      lines.push(`CALL ${String(e.name)}: ${clip(JSON.stringify(e.input), 600)}`);
    } else if (e.type === "tool_end") {
      lines.push(`RESULT ${String(e.name)} [${String(e.status)}]: ${clip(toolOutputText(e.output), 800)}`);
    } else if (e.type === "notice" && e.level !== "info") lines.push(`NOTICE ${String(e.level)}: ${clip(String(e.text), 400)}`);
    else if (e.type === "turn_end") lines.push(`END: ${String(e.reason)}`);
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  // Keep the start (how it planned) and the end (how it finished).
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n… [${text.length - maxChars} characters of the middle left out] …\n${text.slice(-half)}`;
}
