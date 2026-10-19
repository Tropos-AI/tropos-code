// src/providers/model-check.ts — can the router serve a model id right now? Checked offline, before a run or a save.
import type { ProviderStatus } from "./router";

/**
 * Why `id` can't be used, or null. Only what is known without asking the provider: a prefix must name a
 * provider the router knows (built in or added in settings), a bare id must be an Anthropic model, and a
 * provider that needs a key must have one. Whether the provider serves that exact model shows on the first call.
 */
export function modelProblem(id: string, providers: ProviderStatus[]): string | null {
  const ready = providers
    .filter((p) => p.key !== null || !p.info.keyRequired)
    .map((p) => p.info.id)
    .join(", ");
  const slash = id.indexOf("/");
  if (slash >= 0) {
    const prefix = id.slice(0, slash);
    const status = providers.find((p) => p.info.id === prefix);
    if (!status) return `"${prefix}" is not a provider Tropos knows. Name a model as <provider>/<model>, with one of: ${providers.map((p) => p.info.id).join(", ")}.`;
    if (!id.slice(slash + 1)) return `"${id}" names a provider but no model; use ${prefix}/<model>.`;
    if (status.key === null && status.info.keyRequired) {
      return `${status.info.name} isn't connected (no API key). Connect it first (Settings → Models, or TroposSetup provider.connect), or use a model from a ready provider: ${ready}.`;
    }
    return null;
  }
  if (!/^claude-/i.test(id)) {
    return `"${id}" isn't a model id Tropos knows. Anthropic models start with claude- (or use an alias: opus, sonnet, haiku, fable); other providers' models are named <provider>/<model>, e.g. openai/<model>.`;
  }
  return null;
}
