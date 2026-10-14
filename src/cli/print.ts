// src/cli/print.ts
import type { Agent } from "../agent/agent";
import type { AgentEvent, PermissionAnswer, TurnEndReason } from "../agent/events";
import type { Message } from "../api/model";
import type { OutputFormat } from "../config/constants";
import { sanitizeForTerminal } from "../ui/terminal-safe";

export const EXIT_CODES: Record<TurnEndReason, number> = {
  end_turn: 0,
  error: 1,
  refusal: 2,
  max_turns: 3,
  max_tokens: 4,
  context_exceeded: 5,
  blocked: 6,
  aborted: 130,
};

export const PRINT_DENY: PermissionAnswer = {
  kind: "deny",
  message: "Not permitted in non-interactive mode. Allow it with --allowed-tools or a permissions.allow rule.",
};

function finalText(message: Message | undefined): string {
  if (!message) return "";
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

export class PrintRenderer {
  private lastAssistant: Message | undefined;
  private turns = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cost: number | undefined = 0;
  private lastError: string | null = null;

  constructor(
    private readonly format: OutputFormat,
    private readonly out: (s: string) => void,
    private readonly err: (s: string) => void,
    private readonly sessionId: string,
  ) {}

  emit(event: AgentEvent): void {
    if (event.type === "assistant") {
      this.lastAssistant = event.message;
      this.turns++;
    }
    if (event.type === "usage") {
      this.inputTokens += event.inputTokens;
      this.outputTokens += event.outputTokens;
      this.cost = event.totalCostUsd;
    }
    if (event.type === "notice" && event.level !== "info") {
      if (event.level === "error") this.lastError = event.text;
      // Notices can quote hook stderr and server output: no escape sequences reach the terminal.
      this.err(`${event.level}: ${sanitizeForTerminal(event.text)}\n`);
    }
    if (this.format === "stream-json") {
      const line =
        event.type === "assistant"
          ? { type: "assistant", content: event.message.content, stop_reason: event.message.stop_reason, model: event.message.model }
          : event;
      this.out(`${JSON.stringify(line)}\n`);
    }
  }

  finish(reason: TurnEndReason): number {
    // Only a completed, declined or cut-off turn has an answer worth printing; anything else already explained itself on stderr.
    // A cut-off answer still exits non-zero, so scripts never mistake it for a complete one.
    const delivered = reason === "end_turn" || reason === "refusal" || reason === "max_tokens";
    const result = delivered ? finalText(this.lastAssistant) : "";
    if (this.format === "text") {
      if (result) this.out(`${result}\n`);
    } else {
      const summary = {
        type: "result",
        result,
        session_id: this.sessionId,
        is_error: reason !== "end_turn",
        stop: reason,
        num_turns: this.turns,
        usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
        cost_usd: this.cost ?? null,
        error: this.lastError,
      };
      this.out(`${JSON.stringify(summary)}\n`);
    }
    return EXIT_CODES[reason];
  }
}

export async function runPrint(agent: Agent, renderer: PrintRenderer, prompt: string, signal: AbortSignal): Promise<number> {
  const reason = await agent.run(prompt, signal);
  return renderer.finish(reason);
}
