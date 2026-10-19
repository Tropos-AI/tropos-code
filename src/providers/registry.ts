// src/providers/registry.ts — the providers Tropos can talk to, and how model ids name them.
import type { Effort } from "../config/constants";
import type { ChatCapabilities } from "./chat-model";
import type { ResponsesOptions } from "./responses";

export interface ProviderInfo {
  /** Prefix in model ids: "deepseek/deepseek-chat". */
  id: string;
  name: string;
  /** "anthropic": Messages API; "chat": OpenAI-compatible Chat Completions; "responses": OpenAI Responses API. */
  api: "anthropic" | "chat" | "responses";
  baseURL: string;
  /** Environment variables checked for the key, in order. */
  keyEnv: string[];
  keyRequired: boolean;
  /** Shown instead of "no key needed" when a provider without a key may still be signed in another way. */
  noKeyNote?: string;
  /** Where to create a key, shown in /providers. */
  keyURL: string | null;
  /** How the provider's keys begin, so a key pasted into a chat is sealed (src/tools/setup/secrets.ts). */
  keyPrefixes?: readonly string[];
  capabilities: ChatCapabilities;
  /** Options for api "responses". */
  responses?: ResponsesOptions;
}

const RANK: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** The provider's closest effort level at or below ours (or its lowest, when all are above). */
export function clampEffort<T extends string>(effort: Effort, allowed: readonly T[]): T {
  const want = RANK.indexOf(effort);
  let best: T | undefined;
  for (const level of allowed) {
    const rank = RANK.indexOf(level as Effort);
    if (rank !== -1 && rank <= want && (best === undefined || rank > RANK.indexOf(best as Effort))) best = level;
  }
  return best ?? allowed[0]!;
}

const reasoningEffort =
  <T extends string>(allowed: readonly T[]) =>
  (effort: Effort) => ({ reasoning_effort: clampEffort(effort, allowed) });

/**
 * Built-in providers, checked against their documentation in October 2026. Model ids are not listed
 * here on purpose: /providers asks each provider for its current models.
 */
export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic",
    baseURL: "https://api.anthropic.com",
    keyEnv: ["ANTHROPIC_API_KEY"],
    keyRequired: false,
    noKeyNote: "ANTHROPIC_API_KEY or `ant auth login`",
    keyURL: "https://platform.claude.com/settings/keys",
    keyPrefixes: ["sk-ant-"],
    capabilities: { maxTokensParam: null, streamUsage: false },
  },
  {
    id: "openai",
    name: "OpenAI",
    // Newer OpenAI models can't call tools with reasoning on through Chat Completions.
    api: "responses",
    baseURL: "https://api.openai.com/v1",
    keyEnv: ["OPENAI_API_KEY"],
    keyRequired: true,
    keyURL: "https://platform.openai.com/api-keys",
    keyPrefixes: ["sk-"],
    capabilities: { maxTokensParam: null, streamUsage: false },
    responses: { summaries: true, encryptedReasoning: true },
  },
  {
    id: "xai",
    name: "xAI",
    // xAI marks Chat Completions as legacy; reasoning only comes back through Responses.
    api: "responses",
    baseURL: "https://api.x.ai/v1",
    keyEnv: ["XAI_API_KEY"],
    keyRequired: true,
    keyURL: "https://console.x.ai",
    keyPrefixes: ["xai-"],
    capabilities: { maxTokensParam: null, streamUsage: false },
    // Summaries and encrypted reasoning are OpenAI options this project hasn't verified on xAI.
    responses: { summaries: false, encryptedReasoning: false, efforts: ["low", "medium", "high", "xhigh"] },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "chat",
    baseURL: "https://api.deepseek.com",
    keyEnv: ["DEEPSEEK_API_KEY"],
    keyRequired: true,
    keyURL: "https://platform.deepseek.com/api_keys",
    keyPrefixes: ["sk-"],
    // With tools present, earlier reasoning_content must be sent back or the request fails.
    capabilities: { maxTokensParam: null, streamUsage: true, keepReasoning: true, reasoningField: "reasoning_content", effort: reasoningEffort(["low", "high", "max"]) },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    api: "chat",
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: ["OPENROUTER_API_KEY"],
    keyRequired: true,
    keyURL: "https://openrouter.ai/settings/keys",
    keyPrefixes: ["sk-or-"],
    capabilities: {
      maxTokensParam: null,
      // Usage, including the USD cost, is always sent; stream_options is a no-op there.
      streamUsage: false,
      effort: (effort) => ({ reasoning: { effort } }),
      headers: { "HTTP-Referer": "https://troposlabs.com", "X-OpenRouter-Title": "Tropos Code" },
    },
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    api: "chat",
    baseURL: "https://integrate.api.nvidia.com/v1",
    keyEnv: ["NVIDIA_API_KEY"],
    keyRequired: true,
    keyURL: "https://build.nvidia.com",
    keyPrefixes: ["nvapi-"],
    // The catalog's default output limit is small; Kimi there needs its reasoning back during tool use.
    capabilities: { maxTokensParam: "max_tokens", maxTokens: 16_384, streamUsage: true, keepReasoning: true, reasoningField: "reasoning_content" },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    api: "chat",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyRequired: true,
    keyURL: "https://aistudio.google.com/apikey",
    keyPrefixes: ["AIza"],
    capabilities: { maxTokensParam: null, streamUsage: true, effort: reasoningEffort(["low", "medium", "high"]) },
  },
  {
    id: "groq",
    name: "Groq",
    api: "chat",
    baseURL: "https://api.groq.com/openai/v1",
    keyEnv: ["GROQ_API_KEY"],
    keyRequired: true,
    keyURL: "https://console.groq.com/keys",
    keyPrefixes: ["gsk_"],
    capabilities: { maxTokensParam: null, streamUsage: true },
  },
  {
    id: "mistral",
    name: "Mistral",
    api: "chat",
    baseURL: "https://api.mistral.ai/v1",
    keyEnv: ["MISTRAL_API_KEY"],
    keyRequired: true,
    keyURL: "https://console.mistral.ai/api-keys",
    capabilities: { maxTokensParam: null, streamUsage: true },
  },
  {
    id: "together",
    name: "Together AI",
    api: "chat",
    baseURL: "https://api.together.ai/v1",
    keyEnv: ["TOGETHER_API_KEY"],
    keyRequired: true,
    keyURL: "https://api.together.ai/settings/api-keys",
    keyPrefixes: ["tgp_"],
    capabilities: { maxTokensParam: null, streamUsage: true, keepReasoning: true },
  },
  {
    id: "fireworks",
    name: "Fireworks",
    api: "chat",
    baseURL: "https://api.fireworks.ai/inference/v1",
    keyEnv: ["FIREWORKS_API_KEY"],
    keyRequired: true,
    keyURL: "https://fireworks.ai/account/api-keys",
    keyPrefixes: ["fw_"],
    capabilities: { maxTokensParam: null, streamUsage: true, keepReasoning: true, reasoningField: "reasoning_content" },
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    api: "chat",
    baseURL: "https://api.moonshot.ai/v1",
    keyEnv: ["MOONSHOT_API_KEY"],
    keyRequired: true,
    keyURL: "https://platform.kimi.ai/console/api-keys",
    keyPrefixes: ["sk-"],
    capabilities: { maxTokensParam: null, streamUsage: true, keepReasoning: true, reasoningField: "reasoning_content", effort: reasoningEffort(["low", "high", "max"]) },
  },
  {
    id: "zai",
    name: "Z.ai (GLM)",
    api: "chat",
    baseURL: "https://api.z.ai/api/paas/v4",
    keyEnv: ["ZAI_API_KEY"],
    keyRequired: true,
    keyURL: "https://z.ai/manage-apikey/apikey-list",
    capabilities: {
      maxTokensParam: null,
      streamUsage: true,
      keepReasoning: true,
      reasoningField: "reasoning_content",
      // Tool calls are only streamed with tool_stream; keep earlier reasoning instead of clearing it.
      extraBody: { tool_stream: true, thinking: { type: "enabled", clear_thinking: false } },
    },
  },
  {
    id: "qwen",
    name: "Qwen (Alibaba Cloud)",
    api: "chat",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyEnv: ["DASHSCOPE_API_KEY"],
    keyRequired: true,
    keyURL: "https://modelstudio.console.alibabacloud.com",
    keyPrefixes: ["sk-"],
    capabilities: { maxTokensParam: null, streamUsage: true },
  },
  {
    id: "cerebras",
    name: "Cerebras",
    api: "chat",
    baseURL: "https://api.cerebras.ai/v1",
    keyEnv: ["CEREBRAS_API_KEY"],
    keyRequired: true,
    keyURL: "https://cloud.cerebras.ai",
    keyPrefixes: ["csk-"],
    capabilities: { maxTokensParam: null, streamUsage: true },
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    api: "chat",
    baseURL: "http://localhost:11434/v1",
    keyEnv: [],
    keyRequired: false,
    keyURL: null,
    capabilities: { maxTokensParam: null, streamUsage: true },
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    api: "chat",
    baseURL: "http://localhost:1234/v1",
    keyEnv: [],
    keyRequired: false,
    keyURL: null,
    capabilities: { maxTokensParam: null, streamUsage: true },
  },
];

export class ModelIdError extends Error {}

/**
 * "deepseek/deepseek-chat" → DeepSeek, "deepseek-chat". An id whose first segment isn't a provider
 * ("claude-opus-5-5") is an Anthropic model, so existing settings keep working.
 */
export function parseModelId(id: string, providers: ProviderInfo[] = PROVIDERS): { provider: ProviderInfo; model: string } {
  const slash = id.indexOf("/");
  const prefix = slash > 0 ? id.slice(0, slash) : "";
  const named = providers.find((p) => p.id === prefix);
  if (named) {
    const model = id.slice(slash + 1);
    if (!model) throw new ModelIdError(`"${id}" names a provider but no model; use ${named.id}/<model>`);
    return { provider: named, model };
  }
  const anthropic = providers.find((p) => p.id === "anthropic");
  if (!anthropic) throw new ModelIdError(`no provider for model "${id}"`);
  return { provider: anthropic, model: id };
}
