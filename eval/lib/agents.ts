// eval/lib/agents.ts

export interface AgentRun {
  model: string;
  /** Reasoning effort; both agents take the same levels (low … max). */
  effort?: string;
}

/** What an agent's final JSON line says about the run. Null means the agent didn't report it. */
export interface AgentReport {
  isError: boolean | null;
  stop: string | null;
  turns: number | null;
  /** Finished tool calls, and how many of them failed. */
  toolCalls: number | null;
  toolErrors: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AgentAdapter {
  name: string;
  /** Shell command run in the workspace; the prompt is in $PROMPT so it never needs quoting. */
  command(run: AgentRun): string;
  /** Prints the agent's version. */
  versionCommand: string;
  parse(stdout: string): AgentReport;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The last stdout line that is a JSON object with type "result"; agents may print other lines first. */
export function lastResultLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    if (!line.trimStart().startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && (value as { type?: unknown }).type === "result") return value as Record<string, unknown>;
    } catch {
      // not JSON
    }
  }
  return null;
}

const EMPTY: AgentReport = { isError: null, stop: null, turns: null, toolCalls: null, toolErrors: null, costUsd: null, inputTokens: null, outputTokens: null };

export const tropos: AgentAdapter = {
  name: "tropos",
  command: ({ model, effort }) =>
    `tropos -p "$PROMPT" --output-format json --dangerously-skip-permissions --model ${quote(model)}` +
    (effort ? ` --effort ${quote(effort)}` : "") +
    " </dev/null",
  versionCommand: "tropos --version",
  parse(stdout) {
    const r = lastResultLine(stdout);
    if (!r) return EMPTY;
    const usage = (r.usage ?? {}) as Record<string, unknown>;
    return {
      isError: typeof r.is_error === "boolean" ? r.is_error : null,
      stop: typeof r.stop === "string" ? r.stop : null,
      turns: num(r.num_turns),
      toolCalls: num(r.num_tool_calls),
      toolErrors: num(r.num_tool_errors),
      costUsd: num(r.cost_usd),
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
    };
  },
};

export const claude: AgentAdapter = {
  name: "claude",
  command: ({ model, effort }) =>
    `claude -p "$PROMPT" --output-format json --dangerously-skip-permissions --model ${quote(model)}` +
    (effort ? ` --effort ${quote(effort)}` : "") +
    " </dev/null",
  versionCommand: "claude --version",
  parse(stdout) {
    const r = lastResultLine(stdout);
    if (!r) return EMPTY;
    const usage = (r.usage ?? {}) as Record<string, unknown>;
    return {
      isError: typeof r.is_error === "boolean" ? r.is_error : null,
      stop: typeof r.subtype === "string" ? r.subtype : null,
      turns: num(r.num_turns),
      // Claude Code's result line doesn't count tool calls.
      toolCalls: null,
      toolErrors: null,
      costUsd: num(r.total_cost_usd) ?? num(r.cost_usd),
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
    };
  },
};

export const AGENTS: Record<string, AgentAdapter> = { tropos, claude };
