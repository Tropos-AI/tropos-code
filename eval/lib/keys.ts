// eval/lib/keys.ts — which API key an eval run needs, found the way Tropos itself finds it.
import { resolveApiKey, type StoredCredentials } from "../../src/providers/credentials";
import { parseModelId, type ProviderInfo } from "../../src/providers/registry";

export interface RunKey {
  provider: ProviderInfo;
  /** The environment variable the key is passed in, inside the container. */
  envName: string;
  apiKey: string;
}

/**
 * The key for `model`'s provider, from its environment variable or a key saved with /providers.
 * Containers can't use a local login such as `ant auth login`, so a key is always required.
 */
export function runKey(model: string, agents: string[], env: NodeJS.ProcessEnv, saved: StoredCredentials): RunKey {
  const { provider } = parseModelId(model);
  if (provider.id !== "anthropic") {
    const anthropicOnly = agents.filter((a) => a !== "tropos");
    if (anthropicOnly.length) throw new Error(`${anthropicOnly.join(", ")} can only run Anthropic models; run ${model} with --agents tropos`);
  }
  const envName = provider.keyEnv[0];
  if (!envName) throw new Error(`${provider.name} has no API key variable; it can't be used from eval containers`);
  const key = resolveApiKey(provider.keyEnv, provider.id, env, saved);
  if (!key) throw new Error(`No API key for ${provider.name}: set ${envName} or connect it with /providers in tropos`);
  return { provider, envName, apiKey: key.apiKey };
}
