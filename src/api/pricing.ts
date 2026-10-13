export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** USD per million tokens. Cache writes are 1.25× input (5-minute TTL). */
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

/** "anthropic/claude-opus-5-5" and "claude-opus-5-5" are the same model. */
const bare = (model: string) => (model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model);

export function costUsd(model: string, usage: UsageLike): number | undefined {
  const price = PRICES[bare(model)];
  if (!price) return undefined;
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

interface IterationLike extends UsageLike {
  type: string;
  model?: string | null;
}

/**
 * Cost of a whole response. Compaction and refusal-fallback turns bill extra work under
 * `usage.iterations`. Each iteration is priced at its own model when it carries one,
 * otherwise at the requested model.
 */
export function messageCostUsd(
  message: { model: string; usage: UsageLike & { iterations?: IterationLike[] | null; cost_usd?: number } },
  requestedModel: string,
): number | undefined {
  // A provider that reports what it charged (OpenRouter) knows better than any price table.
  if (typeof message.usage.cost_usd === "number") return message.usage.cost_usd;
  const iterations = message.usage.iterations;
  if (!iterations || iterations.length === 0) return costUsd(message.model, message.usage);
  let total = 0;
  for (const iteration of iterations) {
    const cost = costUsd(iteration.model ?? requestedModel, iteration);
    if (cost === undefined) return undefined;
    total += cost;
  }
  return total;
}

/** Tokens of prompt the model saw on this request. */
export function contextTokens(usage: UsageLike): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** Undefined for a model Tropos has no record of, rather than a guess. */
export function contextWindow(model: string): number | undefined {
  return bare(model) in PRICES ? 1_000_000 : undefined; // every model in PRICES has a 1M window
}
