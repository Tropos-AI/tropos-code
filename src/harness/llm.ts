// src/harness/llm.ts — one model call without tools, for the harness lab's editors, composer, selector and reflector.
// They answer with a single JSON object; nothing they write runs until the lab has checked it.
import type { Model } from "../api/model";
import { messageCostUsd } from "../api/pricing";
import type { Effort } from "../config/constants";

export interface LlmConfig {
  model: Model;
  /** The model id. */
  id: string;
  effort: Effort;
}

export interface Completion {
  text: string;
  costUsd: number | undefined;
}

export async function complete(llm: LlmConfig, system: string, prompt: string, signal: AbortSignal): Promise<Completion> {
  const message = await llm.model.send(
    { model: llm.id, effort: llm.effort, system, tools: [], messages: [{ role: "user", content: prompt }], refusalFallback: false },
    { onText: () => {}, onThinking: () => {} },
    signal,
  );
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return { text, costUsd: messageCostUsd(message, llm.id) };
}

/**
 * The JSON object in a reply: the whole text, else a ```json fence, else the span from the first "{" to the last "}".
 * Throws when none of them parses to an object.
 */
export function extractJson(text: string): Record<string, unknown> {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const span = first !== -1 && last > first ? text.slice(first, last + 1) : undefined;
  for (const candidate of [text.trim(), fence, span]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // try the next form
    }
  }
  throw new Error(`the reply holds no JSON object: ${text.slice(0, 200)}`);
}

/** Sums costs, staying undefined only when every part is unknown. */
export function addCost(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : a + b;
}
