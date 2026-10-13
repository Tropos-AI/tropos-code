// src/providers/chat-model.ts — any provider with an OpenAI-compatible Chat Completions API.
import type { Message, Model, StreamHandlers, TurnRequest } from "../api/model";
import type { Effort } from "../config/constants";
import { ChatAccumulator, sseJson, toChatMessages, toChatTools } from "./chat";

/** What differs between Chat Completions providers. */
export interface ChatCapabilities {
  /** Which output-limit field the API takes, or null to leave it to the provider's default. */
  maxTokensParam: "max_tokens" | "max_completion_tokens" | null;
  maxTokens?: number;
  /** Ask for token usage in the final chunk (stream_options.include_usage). */
  streamUsage: boolean;
  /** Request fields that set reasoning effort, or nothing when the provider has no such control. */
  effort?(effort: Effort, model: string): Record<string, unknown> | undefined;
  /** Store reasoning and send it back on later turns (required by some reasoning models during tool loops). */
  keepReasoning?: boolean;
  /** Field to send reasoning back in when it isn't known which one it arrived in. */
  reasoningField?: "reasoning_content" | "reasoning";
  /** Extra request fields, e.g. OpenRouter's usage accounting. */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface ChatEndpoint {
  /** Provider id, used in error messages and model ids. */
  id: string;
  name: string;
  baseURL: string;
  capabilities: ChatCapabilities;
  /** Resolved at request time, so a key added with /providers works without restarting. */
  apiKey(): Promise<string | null>;
  keyRequired: boolean;
  /** Where to point the user when the key is missing or rejected. */
  keyHint: string;
}

/** An HTTP or network failure from a provider, worded for the user. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function errorDetail(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).slice(0, 2000);
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const msg = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
    if (msg) return msg;
  } catch {
    // not JSON
  }
  return text.trim() || res.statusText;
}

export function describeStatus(endpoint: Pick<ChatEndpoint, "name" | "keyHint">, status: number, detail: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(`${endpoint.name} rejected the API key (${status}): ${detail}. ${endpoint.keyHint}`, status, false);
  }
  if (status === 404) return new ProviderError(`${endpoint.name} does not know this model or endpoint (404): ${detail}`, status, false);
  if (status === 429) return new ProviderError(`Rate limited by ${endpoint.name}, even after retrying: ${detail}`, status, true);
  if (status >= 500) return new ProviderError(`${endpoint.name} is having trouble (${status}), even after retrying: ${detail}`, status, true);
  return new ProviderError(`${endpoint.name} rejected the request (${status}): ${detail}`, status, false);
}

async function authHeaders(endpoint: ChatEndpoint): Promise<Record<string, string>> {
  const key = await endpoint.apiKey();
  if (!key && endpoint.keyRequired) throw new ProviderError(`No API key for ${endpoint.name}. ${endpoint.keyHint}`, null, false);
  return { ...(key ? { authorization: `Bearer ${key}` } : {}), ...endpoint.capabilities.headers };
}

/** POSTs with retries on 429, 5xx and network errors; only the request is retried, never a started stream. */
export async function post(endpoint: ChatEndpoint, path: string, body: unknown, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
  const headers = { "content-type": "application/json", accept: "text/event-stream", ...(await authHeaders(endpoint)) };
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(`${trimSlash(endpoint.baseURL)}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (signal.aborted) throw err;
      if (attempt < RETRIES) {
        await sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      throw new ProviderError(`Could not reach ${endpoint.name} at ${endpoint.baseURL}: ${(err as Error).message}`, null, true);
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRIES) {
      const after = Number(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => {});
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_RETRY_WAIT_MS) : 1000 * 2 ** attempt, signal);
      continue;
    }
    throw describeStatus(endpoint, res.status, await errorDetail(res));
  }
}

/** The request body for one turn; `model` is the provider's own id (without the "provider/" prefix). */
export function chatBody(endpoint: ChatEndpoint, model: string, req: TurnRequest): Record<string, unknown> {
  const caps = endpoint.capabilities;
  const tools = toChatTools(req.tools);
  return {
    model,
    messages: toChatMessages(req.system, req.messages, { keepReasoning: caps.keepReasoning, reasoningField: caps.reasoningField }),
    ...(tools.length ? { tools } : {}),
    stream: true,
    ...(caps.streamUsage ? { stream_options: { include_usage: true } } : {}),
    ...(caps.maxTokensParam && caps.maxTokens ? { [caps.maxTokensParam]: caps.maxTokens } : {}),
    ...caps.effort?.(req.effort, model),
    ...caps.extraBody,
  };
}

/** Models that rejected our reasoning-effort fields; they are sent without them from then on. */
const noEffort = new Set<string>();

/**
 * Sends `body`; if the provider rejects it with a 400 that mentions reasoning or effort (a model
 * without reasoning), sends `fallback` instead and remembers that for `modelKey`.
 */
export async function postWithEffortFallback(
  endpoint: ChatEndpoint,
  path: string,
  body: Record<string, unknown>,
  fallback: Record<string, unknown> | null,
  modelKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (!fallback) return post(endpoint, path, body, signal, fetchImpl);
  if (noEffort.has(modelKey)) return post(endpoint, path, fallback, signal, fetchImpl);
  try {
    return await post(endpoint, path, body, signal, fetchImpl);
  } catch (err) {
    if (!(err instanceof ProviderError) || err.status !== 400 || !/reason|effort|thinking/i.test(err.message)) throw err;
    noEffort.add(modelKey);
    return post(endpoint, path, fallback, signal, fetchImpl);
  }
}

export class ChatCompletionsModel implements Model {
  constructor(
    private readonly endpoint: ChatEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** `req.model` is the full id ("deepseek/deepseek-chat"); the provider gets the part after the prefix. */
  async send(req: TurnRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<Message> {
    const model = req.model.slice(req.model.indexOf("/") + 1);
    const body = chatBody(this.endpoint, model, req);
    const effortKeys = Object.keys(this.endpoint.capabilities.effort?.(req.effort, model) ?? {});
    const fallback = effortKeys.length ? Object.fromEntries(Object.entries(body).filter(([k]) => !effortKeys.includes(k))) : null;
    const res = await postWithEffortFallback(this.endpoint, "/chat/completions", body, fallback, req.model, signal, this.fetchImpl);
    if (!res.body) throw new ProviderError(`${this.endpoint.name} sent an empty response.`, res.status, true);
    const acc = new ChatAccumulator(req.model, handlers);
    for await (const chunk of sseJson(res.body)) {
      const error = (chunk as { error?: { message?: string } }).error;
      if (error) throw new ProviderError(`${this.endpoint.name} reported an error mid-response: ${error.message ?? JSON.stringify(error)}`, null, true);
      acc.push(chunk as Parameters<ChatAccumulator["push"]>[0]);
    }
    return acc.finalMessage({ keepReasoning: this.endpoint.capabilities.keepReasoning });
  }
}

/** Model ids the provider offers (GET /models), sorted. */
export async function listChatModels(endpoint: ChatEndpoint, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${trimSlash(endpoint.baseURL)}/models`, { headers: await authHeaders(endpoint), signal });
  } catch (err) {
    if (err instanceof ProviderError || signal.aborted) throw err;
    throw new ProviderError(`Could not reach ${endpoint.name} at ${endpoint.baseURL}: ${(err as Error).message}`, null, true);
  }
  if (!res.ok) throw describeStatus(endpoint, res.status, await errorDetail(res));
  const body = (await res.json()) as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown; name?: unknown }> };
  const entries = body.data ?? body.models ?? [];
  const ids = entries.map((m) => (typeof m.id === "string" ? m.id : typeof (m as { name?: unknown }).name === "string" ? (m as { name: string }).name : null));
  return [...new Set(ids.filter((id): id is string => !!id))].sort();
}
