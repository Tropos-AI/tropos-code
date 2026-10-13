// src/providers/reasoning.ts — other providers' reasoning, kept in Anthropic-format history.

/**
 * What a non-Anthropic provider needs back on later turns. Stored on an unsigned thinking block,
 * which the Anthropic path drops (see anthropicHistory), so sessions can still switch providers.
 */
export interface ForeignReasoning {
  /** The Chat Completions field the reasoning arrived in, and must be returned in. */
  field?: "reasoning_content" | "reasoning";
  /** Gemini: the thought signature of each tool call, by tool_use id; required on the way back. */
  toolSignatures?: Record<string, string>;
  /** Responses API (OpenAI, xAI): reasoning output items, returned verbatim. */
  items?: unknown[];
}

export interface ForeignThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: "";
  tropos?: ForeignReasoning;
}

export function foreignThinking(thinking: string, data: ForeignReasoning): ForeignThinkingBlock {
  const hasData = Object.values(data).some((v) => v !== undefined);
  return { type: "thinking", thinking, signature: "", ...(hasData ? { tropos: data } : {}) };
}

/** The stored reasoning of an unsigned thinking block; null for anything else (Anthropic's own thinking). */
export function readForeign(block: { type: string; signature?: unknown; thinking?: unknown; tropos?: unknown }): { text: string; data: ForeignReasoning } | null {
  if (block.type !== "thinking" || block.signature) return null;
  return { text: typeof block.thinking === "string" ? block.thinking : "", data: (block.tropos as ForeignReasoning | undefined) ?? {} };
}
