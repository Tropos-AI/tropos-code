// src/providers/router.ts — one Model that sends each request to the provider its model id names.
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicModel, type Message, type Model, type StreamHandlers, type TurnRequest } from "../api/model";
import type { ProviderSetting } from "../config/settings";
import { ChatCompletionsModel, listChatModels, type ChatEndpoint } from "./chat-model";
import { ResponsesModel } from "./responses";
import { readCredentials, removeApiKey, resolveApiKey, saveApiKey, type KeySource } from "./credentials";
import { PROVIDERS, parseModelId, type ProviderInfo } from "./registry";

export interface ProviderStatus {
  info: ProviderInfo;
  /** Where the key comes from; null when there is none (fine for local providers). */
  key: KeySource | null;
  baseURL: string;
  /** Added in settings.json, not built in. */
  custom?: boolean;
}

export interface RouterOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  settings: Record<string, ProviderSetting>;
  fetch?: typeof fetch;
  /** Overrides how the Anthropic client is made (tests). */
  anthropic?: (apiKey: string | undefined) => Model;
}

/** Built-in providers plus any custom OpenAI-compatible endpoints from user settings. */
export function allProviders(settings: Record<string, ProviderSetting>): ProviderInfo[] {
  const custom: ProviderInfo[] = Object.entries(settings)
    .filter(([id, s]) => !PROVIDERS.some((p) => p.id === id) && s.baseURL)
    .map(([id, s]) => ({
      id,
      name: s.name ?? id,
      api: s.api ?? "chat",
      baseURL: s.baseURL!,
      keyEnv: [`${id.toUpperCase().replace(/-/g, "_")}_API_KEY`],
      keyRequired: false,
      keyURL: null,
      capabilities: { maxTokensParam: null, streamUsage: true },
    }));
  return [...PROVIDERS, ...custom];
}

export class ProviderRouter implements Model {
  private readonly providers: ProviderInfo[];
  private anthropicModel: { key: string | undefined; model: Model } | null = null;

  constructor(private readonly opts: RouterOptions) {
    this.providers = allProviders(opts.settings);
  }

  list(): ProviderInfo[] {
    return this.providers;
  }

  find(id: string): ProviderInfo | undefined {
    return this.providers.find((p) => p.id === id);
  }

  baseURL(info: ProviderInfo): string {
    return this.opts.settings[info.id]?.baseURL ?? info.baseURL;
  }

  async status(): Promise<ProviderStatus[]> {
    const saved = await readCredentials(this.opts.home);
    return this.providers.map((info) => ({
      info,
      key: resolveApiKey(info.keyEnv, info.id, this.opts.env, saved)?.source ?? null,
      baseURL: this.baseURL(info),
      custom: !this.builtin(info),
    }));
  }

  async connect(id: string, apiKey: string): Promise<void> {
    await saveApiKey(this.opts.home, id, apiKey);
  }

  disconnect(id: string): Promise<boolean> {
    return removeApiKey(this.opts.home, id);
  }

  private async key(info: ProviderInfo): Promise<string | null> {
    return resolveApiKey(info.keyEnv, info.id, this.opts.env, await readCredentials(this.opts.home))?.apiKey ?? null;
  }

  private endpoint(info: ProviderInfo): ChatEndpoint {
    const hint = info.keyEnv.length
      ? `Run /providers to connect ${info.name}, or set ${info.keyEnv[0]}.`
      : `Run /providers to connect ${info.name}.`;
    return {
      id: info.id,
      name: info.name,
      baseURL: this.baseURL(info),
      capabilities: info.capabilities,
      apiKey: () => this.key(info),
      keyRequired: info.keyRequired,
      keyHint: hint,
    };
  }

  /** Anthropic keeps the SDK's own credential lookup (ANTHROPIC_API_KEY, `ant auth`); a key saved with /providers comes next. */
  private async anthropic(): Promise<Model> {
    const info = this.find("anthropic")!;
    const fromEnv = info.keyEnv.some((name) => this.opts.env[name]?.trim());
    const saved = fromEnv ? undefined : (await readCredentials(this.opts.home)).anthropic?.apiKey;
    if (this.anthropicModel?.key !== saved || !this.anthropicModel) {
      const make = this.opts.anthropic ?? ((apiKey) => new AnthropicModel(new Anthropic({ maxRetries: 2, ...(apiKey ? { apiKey } : {}) })));
      this.anthropicModel = { key: saved, model: make(saved) };
    }
    return this.anthropicModel.model;
  }

  /** An Anthropic-compatible endpoint the owner added: the Anthropic SDK at its base URL, with its own key. */
  private async customAnthropic(info: ProviderInfo): Promise<Model> {
    const key = await this.key(info);
    const client = new Anthropic({ maxRetries: 0, baseURL: this.baseURL(info), apiKey: key ?? "none", ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) });
    return new AnthropicModel(client);
  }

  private builtin(info: ProviderInfo): boolean {
    return PROVIDERS.some((p) => p.id === info.id);
  }

  async send(req: TurnRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<Message> {
    const { provider, model } = parseModelId(req.model, this.providers);
    if (provider.api === "anthropic") {
      const target = this.builtin(provider) ? await this.anthropic() : await this.customAnthropic(provider);
      return target.send({ ...req, model }, handlers, signal);
    }
    if (provider.api === "responses") {
      const opts = provider.responses ?? { summaries: false, encryptedReasoning: false };
      return new ResponsesModel(this.endpoint(provider), opts, this.opts.fetch).send(req, handlers, signal);
    }
    return new ChatCompletionsModel(this.endpoint(provider), this.opts.fetch).send(req, handlers, signal);
  }

  /** The provider's model ids for the picker. */
  async models(id: string, signal: AbortSignal): Promise<string[]> {
    const info = this.find(id);
    if (!info) throw new Error(`Unknown provider ${id}`);
    if (info.api === "anthropic") {
      const key = await this.key(info);
      const client = this.builtin(info)
        ? new Anthropic({ maxRetries: 1, ...(key ? { apiKey: key } : {}) })
        : new Anthropic({ maxRetries: 1, baseURL: this.baseURL(info), apiKey: key ?? "none" });
      const ids: string[] = [];
      for await (const m of client.models.list({}, { signal })) ids.push(m.id);
      return ids.sort();
    }
    return listChatModels(this.endpoint(info), signal, this.opts.fetch);
  }
}
