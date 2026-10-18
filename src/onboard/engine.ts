// src/onboard/engine.ts — what the setup wizard (terminal and web) knows and does. The steps' state is read from the
// real machine; every outside effect (network, Docker, the service manager, the clock) comes in through OnboardDeps,
// so the tests run against temp homes and fakes (control-plane spec §1, §2.6).
import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { DEFAULT_MODEL } from "../config/constants";
import { readSettingsFile, type PartialSettings } from "../config/settings";
import { gatewayFile, updateConfigFile, updateUserSettings } from "../config/store";
import { runDoctor } from "../doctor/engine";
import { defaultRunner } from "../doctor/runner";
import type { DoctorOptions, Report, Runner } from "../doctor/types";
import { isRecord, pidAlive, readJsonFile } from "../doctor/util";
import { loadGatewayConfig, gatewayLogPath, telegramToken } from "../gateway/config";
import { ensureDefaultProject } from "../gateway/projects";
import { TelegramApi } from "../gateway/telegram/api";
import { CredentialsError, readCredentials, resolveApiKey, saveApiKey } from "../providers/credentials";
import { listChatModels, type ChatEndpoint } from "../providers/chat-model";
import { parseModelId, type ProviderInfo } from "../providers/registry";
import { allProviders } from "../providers/router";
import { programArguments, serviceEnv, serviceManager, type ServiceManager } from "../service";
import type { OnboardState, OnboardStep, OnboardStepId } from "../web/admin/api";
import type { Confinement } from "../exec/backend";
import { confinementAvailable } from "../exec/confined";
import { dashboardLoginLink, dashboardPort } from "../web/links";
import { loginCodesFor } from "../web/login-codes";
import { tailscaleStatus, type TailscaleStatus } from "../remote/tailscale";
import { readOnboardingFlags, writeOnboardingFlags } from "./flags";

export const DEFAULT_SANDBOX_IMAGE = "alpine:3.22";
const VALIDATE_TIMEOUT_MS = 15_000;
/** A local server (Ollama, LM Studio) only counts as connected when it answers quickly on its port. */
const LOCAL_PROBE_MS = 1_500;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

/** A message meant for the person running setup, shown as it is (no stack, no jargon). */
export class OnboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardError";
  }
}

export interface OnboardDeps {
  /** Tropos's data directory. */
  home: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  now(): number;
  /** Runs `docker …` and friends; also the doctor's runner. */
  runner: Runner;
  service: ServiceManager;
  execPath: string;
  scriptPath?: string;
  /** Lists Anthropic models with exactly this key (tests replace it; the default uses the SDK with `fetch`). */
  anthropicModels?: (key: string, signal: AbortSignal) => Promise<string[]>;
  /** Doctor settings for the health step (tests pass `checks`). */
  doctor?: Partial<DoctorOptions>;
  /** Whether a process is running (the gateway's pid). Tests replace it. */
  alive(pid: number): boolean;
  /** Telegram's API address; only tests set it. */
  telegramBaseUrl?: string;
  /** Which OS confinement chat commands can use here (null: none). */
  confinement(): Promise<Confinement | null>;
  /** Where a program is on PATH, or null. */
  which(cmd: string): string | null;
  /** Tailscale as seen from this computer (it runs through `runner`, so tests fake the runner). */
  tailscale: { status(): Promise<TailscaleStatus> };
  /** What the owner uses to log in to the dashboard: a one-time link for this computer, a code for a phone. */
  login: { oneTimeUrl(): Promise<string>; code(): Promise<string> };
}

export interface OnboardDepsInput extends Partial<Omit<OnboardDeps, "home" | "env" | "runner">> {
  home: string;
  env?: NodeJS.ProcessEnv;
  runner?: Partial<Runner>;
}

export function makeOnboardDeps(input: OnboardDepsInput): OnboardDeps {
  const env = input.env ?? process.env;
  const userHome = input.userHome ?? env.HOME ?? "";
  const runner = { ...defaultRunner(), ...input.runner };
  return {
    home: input.home,
    userHome,
    env,
    fetch: input.fetch ?? runner.fetch,
    now: input.now ?? Date.now,
    runner,
    service: input.service ?? serviceManager({ userHome }),
    execPath: input.execPath ?? process.execPath,
    scriptPath: input.scriptPath ?? process.argv[1],
    anthropicModels: input.anthropicModels,
    doctor: input.doctor,
    alive: input.alive ?? pidAlive,
    telegramBaseUrl: input.telegramBaseUrl,
    confinement: input.confinement ?? confinementAvailable,
    which: input.which ?? ((cmd) => Bun.which(cmd)),
    tailscale: input.tailscale ?? { status: () => tailscaleStatus(runner) },
    login: input.login ?? {
      oneTimeUrl: async () => dashboardLoginLink(input.home, dashboardPort(await loadGatewayConfig(input.home))),
      code: () => loginCodesFor(input.home).issueCode(),
    },
  };
}

// ---------- reading the machine ----------

async function readSettings(home: string): Promise<PartialSettings> {
  try {
    return (await readSettingsFile(join(home, "settings.json"))) ?? {};
  } catch {
    return {}; // the doctor reports an unreadable settings file; the wizard just treats it as empty
  }
}

export interface ProviderChoice {
  info: ProviderInfo;
  /** Where its key comes from now; null when none. */
  source: "env" | "saved" | "local" | null;
  envName?: string;
}

/** Every provider with how it is connected right now (no key, a saved key, an env var, or a local server answering). */
export async function detectProviders(deps: OnboardDeps): Promise<ProviderChoice[]> {
  const settings = (await readSettings(deps.home)).providers ?? {};
  let saved = {};
  try {
    saved = await readCredentials(deps.home);
  } catch (err) {
    if (!(err instanceof CredentialsError)) throw err;
  }
  const out: ProviderChoice[] = [];
  for (const info of allProviders(settings)) {
    const key = resolveApiKey(info.keyEnv, info.id, deps.env, saved);
    if (key) {
      out.push({ info, source: key.source.kind, envName: key.source.kind === "env" ? key.source.name : undefined });
      continue;
    }
    const baseURL = settings[info.id]?.baseURL ?? info.baseURL;
    if (!info.keyRequired && info.id !== "anthropic" && LOCAL.test(baseURL) && (await localServerUp(deps.fetch, baseURL))) {
      out.push({ info, source: "local" });
      continue;
    }
    out.push({ info, source: null });
  }
  return out;
}

async function localServerUp(fetchFn: typeof fetch, baseURL: string): Promise<boolean> {
  try {
    return (await fetchFn(`${baseURL.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(LOCAL_PROBE_MS) })).ok;
  } catch {
    return false;
  }
}

/** The model that will be used: the one in settings.json, or the built-in default. */
export async function effectiveModel(home: string): Promise<{ model: string; explicit: boolean }> {
  const model = (await readSettings(home)).model;
  return model ? { model, explicit: true } : { model: DEFAULT_MODEL, explicit: false };
}

export interface SandboxStatus {
  ok: boolean;
  docker: boolean;
  image: string;
  imagePresent: boolean;
  problem?: string;
}

async function sandboxImage(home: string): Promise<string> {
  try {
    return (await loadGatewayConfig(home)).sandbox.image;
  } catch {
    return DEFAULT_SANDBOX_IMAGE;
  }
}

/** Is Docker reachable and the sandbox image present? `pull` fetches the image when Docker works but it is missing. */
export async function checkSandbox(deps: OnboardDeps, opts: { pull?: boolean } = {}): Promise<SandboxStatus> {
  const image = await sandboxImage(deps.home);
  const info = await deps.runner.exec("docker", ["info", "--format", "{{.ServerVersion}}"], 8_000);
  if (info.code !== 0) {
    const missing = info.error?.includes("not found");
    return { ok: false, docker: false, image, imagePresent: false, problem: missing ? "Docker is not installed." : "Docker is installed but its daemon is not reachable." };
  }
  const have = async () => (await deps.runner.exec("docker", ["image", "inspect", "--format", "{{.Id}}", image], 8_000)).code === 0;
  let present = await have();
  let problem: string | undefined;
  if (!present && opts.pull && !image.startsWith("-")) {
    const pulled = await deps.runner.exec("docker", ["pull", image], 600_000);
    present = pulled.code === 0;
    if (!present) problem = `Could not pull ${image}: ${((pulled.error ?? pulled.stderr.trim().split("\n").pop()) || "docker pull failed").slice(0, 200)}`;
  }
  if (!present && !problem) problem = `The sandbox image ${image} is not downloaded yet.`;
  return { ok: present, docker: true, image, imagePresent: present, ...(problem ? { problem } : {}) };
}

async function approvedSenders(home: string): Promise<number> {
  const pairing = await readJsonFile(join(home, "gateway", "pairing.json"));
  return isRecord(pairing) && Array.isArray(pairing.approved) ? pairing.approved.length : 0;
}

export async function telegramConfigured(deps: OnboardDeps): Promise<boolean> {
  try {
    return Boolean(telegramToken(await loadGatewayConfig(deps.home), deps.env));
  } catch {
    return false;
  }
}

/** A read-only doctor run (local checks only). */
export function healthReport(deps: OnboardDeps): Promise<Report> {
  return runDoctor({ home: deps.home, userHome: deps.userHome, env: deps.env, now: deps.now, ...deps.doctor, runner: { ...deps.runner, ...deps.doctor?.runner } });
}

// ---------- the state ----------

const TITLES: Record<OnboardStepId, string> = {
  provider: "Connect a model provider",
  model: "Choose a model",
  telegram: "Connect Telegram",
  pairing: "Pair your Telegram account",
  sandbox: "Prepare the sandbox",
  service: "Run in the background",
  health: "Health check",
};
export const REQUIRED_STEPS: readonly OnboardStepId[] = ["provider", "model"];

const step = (id: OnboardStepId, status: OnboardStep["status"], detail?: string): OnboardStep => ({
  id,
  title: TITLES[id],
  status,
  optional: !REQUIRED_STEPS.includes(id),
  ...(detail ? { detail } : {}),
});

export async function computeOnboardState(deps: OnboardDeps): Promise<OnboardState> {
  const flags = await readOnboardingFlags(deps.home);
  const providers = await detectProviders(deps);
  const connected = providers.filter((p) => p.source !== null);
  const steps: OnboardStep[] = [];

  steps.push(
    connected.length
      ? step("provider", "done", connected.map((p) => `${p.info.name} (${p.source === "env" ? `$${p.envName}` : p.source === "saved" ? "saved key" : "local server"})`).join(", "))
      : step("provider", "todo", "No API key found. Add one, or start a local model server."),
  );

  const { model, explicit } = await effectiveModel(deps.home);
  let owner = "anthropic";
  try {
    owner = parseModelId(model, allProviders((await readSettings(deps.home)).providers ?? {})).provider.id;
  } catch {
    // an unparsable id is reported as not usable below
  }
  const ownerConnected = connected.some((p) => p.info.id === owner);
  steps.push(
    ownerConnected
      ? step("model", "done", explicit ? model : `${model} (default)`)
      : step("model", "todo", connected.length ? `${model} needs ${owner}, which is not connected. Pick a model from a connected provider.` : "Connect a provider first."),
  );

  steps.push(
    (await telegramConfigured(deps)) ? step("telegram", "done", "Bot token set") : step("telegram", "todo", "Optional: chat with Tropos from Telegram."),
  );

  const senders = await approvedSenders(deps.home);
  steps.push(senders ? step("pairing", "done", `${senders} approved sender${senders === 1 ? "" : "s"}`) : step("pairing", "todo", "Nobody is approved yet; message your bot to get a code."));

  const sandbox = await checkSandbox(deps);
  steps.push(
    sandbox.ok
      ? step("sandbox", "done", `Docker is running and ${sandbox.image} is present`)
      : step("sandbox", sandbox.docker ? "todo" : "warn", sandbox.problem),
  );

  const svc = await deps.service.status().catch(() => null);
  steps.push(
    !svc || svc.manager === "none"
      ? step("service", "skipped", "Not available on this system; start the gateway with `tcode gateway`.")
      : svc.installed
        ? step("service", "done", `${svc.manager}: installed, ${svc.running ? "running" : "stopped"}`)
        : step("service", "todo", "Optional: keep the gateway running in the background."),
  );

  const report = await healthReport(deps).catch(() => null);
  steps.push(
    !report
      ? step("health", "warn", "The health check could not run.")
      : report.summary.error
        ? step("health", "error", `${report.summary.error} error${report.summary.error === 1 ? "" : "s"}, ${report.summary.warn} warning${report.summary.warn === 1 ? "" : "s"}`)
        : report.summary.warn
          ? step("health", "warn", `${report.summary.warn} warning${report.summary.warn === 1 ? "" : "s"}`)
          : step("health", "done", "No problems found"),
  );

  // A step the owner chose to skip shows as skipped unless it has been done since; the required ones cannot be skipped.
  const skipped = new Set(flags.skipped ?? []);
  const merged = steps.map((s) => (s.status !== "done" && s.optional && skipped.has(s.id) ? { ...s, status: "skipped" as const } : s));
  const complete = REQUIRED_STEPS.every((id) => merged.find((s) => s.id === id)?.status === "done");
  return { steps: merged, complete, dismissed: Boolean(flags.dismissedAt) };
}

// ---------- keys and models ----------

export interface ValidateResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/** Removes the key (raw or URL-encoded) and any bearer token from text that may be shown. */
export function redactKey(text: string, key: string): string {
  let out = text;
  for (const form of new Set([key, encodeURIComponent(key)])) if (form) out = out.split(form).join("<key>");
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer <key>");
}

async function anthropicModelIds(deps: OnboardDeps, key: string, signal: AbortSignal): Promise<string[]> {
  if (deps.anthropicModels) return deps.anthropicModels(key, signal);
  const client = new Anthropic({ apiKey: key, maxRetries: 0, fetch: deps.fetch as never });
  const ids: string[] = [];
  for await (const m of client.models.list({}, { signal })) {
    ids.push(m.id);
    if (ids.length >= 500) break;
  }
  return ids.sort();
}

async function listWithKey(deps: OnboardDeps, info: ProviderInfo, baseURL: string, key: string, signal: AbortSignal): Promise<string[]> {
  if (info.api === "anthropic") return anthropicModelIds(deps, key, signal);
  const endpoint: ChatEndpoint = {
    id: info.id,
    name: info.name,
    baseURL,
    capabilities: info.capabilities,
    apiKey: async () => key || null,
    keyRequired: info.keyRequired,
    keyHint: info.keyURL ? `Create a key at ${info.keyURL}.` : "Check the key.",
  };
  return listChatModels(endpoint, signal, deps.fetch);
}

async function providerById(deps: OnboardDeps, id: string): Promise<{ info: ProviderInfo; baseURL: string } | undefined> {
  const settings = (await readSettings(deps.home)).providers ?? {};
  const info = allProviders(settings).find((p) => p.id === id);
  return info ? { info, baseURL: settings[id]?.baseURL ?? info.baseURL } : undefined;
}

/**
 * ONE real call with exactly this key: the provider's model listing (the cheapest authenticated request, and it also
 * answers the model step). The key is not saved, and it is removed from any error text.
 */
export async function validateKey(deps: OnboardDeps, input: { provider: string; key: string }): Promise<ValidateResult> {
  const found = await providerById(deps, input.provider);
  if (!found) return { ok: false, models: [], error: `Unknown provider "${input.provider}".` };
  const key = input.key.trim();
  if (found.info.keyRequired && !key) return { ok: false, models: [], error: "The API key is empty." };
  if (/\s/.test(key)) return { ok: false, models: [], error: "The API key contains spaces or line breaks; paste just the key." };
  try {
    const models = await listWithKey(deps, found.info, found.baseURL, key, AbortSignal.timeout(VALIDATE_TIMEOUT_MS));
    return { ok: true, models };
  } catch (err) {
    const text = err instanceof Error && err.message ? err.message : "The provider did not answer.";
    return { ok: false, models: [], error: redactKey(text, key).split("\n")[0]!.slice(0, 300) };
  }
}

/** The models a provider offers with the key it already has (environment or saved). */
export async function listModels(deps: OnboardDeps, provider: string): Promise<ValidateResult> {
  const found = await providerById(deps, provider);
  if (!found) return { ok: false, models: [], error: `Unknown provider "${provider}".` };
  let saved = {};
  try {
    saved = await readCredentials(deps.home);
  } catch {
    // treated as no saved key
  }
  const key = resolveApiKey(found.info.keyEnv, provider, deps.env, saved)?.apiKey ?? "";
  return validateKey(deps, { provider, key });
}

/** Stores the key with the existing credentials writer (0600). Throws CredentialsError with a message that never holds the key. */
export async function saveKey(deps: OnboardDeps, input: { provider: string; key: string }): Promise<void> {
  if (!(await providerById(deps, input.provider))) throw new CredentialsError(`Unknown provider "${input.provider}".`);
  await saveApiKey(deps.home, input.provider, input.key);
}

/** "deepseek/deepseek-chat": Anthropic ids stay bare, as they always were in settings. */
export function modelIdFor(provider: string, model: string): string {
  return provider === "anthropic" ? model : `${provider}/${model}`;
}

const NOT_CHAT = /embed|whisper|tts|dall-e|image|moderation|rerank|guard|transcrib|speech|audio/i;

/** The best known model of a provider's listing: Anthropic's default or its newest Opus/Sonnet, otherwise the first chat-like id. */
export function pickDefaultModel(provider: string, models: string[]): string | undefined {
  const chat = models.filter((m) => !NOT_CHAT.test(m));
  const pool = chat.length ? chat : models;
  if (provider === "anthropic") {
    if (pool.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
    for (const family of ["opus", "sonnet"]) {
      const hit = pool.filter((m) => m.includes(family)).sort().pop();
      if (hit) return hit;
    }
  }
  return pool[0];
}

export async function saveModel(deps: OnboardDeps, modelId: string): Promise<void> {
  await updateUserSettings(deps.home, { model: modelId });
}

// ---------- telegram, sandbox, service ----------

export async function verifyTelegram(deps: OnboardDeps, token: string): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const api = new TelegramApi({ token, fetch: deps.fetch });
  try {
    return { ok: true, username: (await api.getMe(AbortSignal.timeout(VALIDATE_TIMEOUT_MS))).username };
  } catch (err) {
    return { ok: false, error: redactKey(api.redact(err instanceof Error ? err.message : "Telegram did not answer."), token).slice(0, 300) };
  }
}

export async function saveTelegram(deps: OnboardDeps, token: string): Promise<void> {
  await updateConfigFile(gatewayFile(deps.home), { telegram: { botToken: token.trim() } });
}

/** The same install `tcode gateway install` does. */
export async function installService(deps: OnboardDeps): Promise<{ unitPath: string; hint?: string }> {
  await ensureDefaultProject(deps.home);
  return deps.service.install({
    programArguments: programArguments(deps.execPath, deps.scriptPath),
    workingDirectory: deps.home,
    logPath: gatewayLogPath(deps.home),
    env: serviceEnv(deps.env, deps.userHome),
  });
}

// ---------- finishing ----------

export async function finish(deps: OnboardDeps, opts: { skipped?: OnboardStepId[] } = {}): Promise<OnboardState> {
  const prior = await readOnboardingFlags(deps.home);
  const requested: string[] = opts.skipped ?? prior.skipped ?? [];
  const skipped = [...new Set(requested)].filter((id) => !(REQUIRED_STEPS as readonly string[]).includes(id));
  await writeOnboardingFlags(deps.home, { dismissedAt: new Date(deps.now()).toISOString(), ...(skipped.length ? { skipped } : {}), ...(prior.autonomyChosen ? { autonomyChosen: true } : {}) });
  return computeOnboardState(deps);
}

/** Forgets that the wizard was finished or skipped, so every step is offered again. */
export async function reopen(deps: OnboardDeps): Promise<OnboardState> {
  // What the owner already chose stays chosen; only "finished" and "skipped" are forgotten.
  const prior = await readOnboardingFlags(deps.home);
  await writeOnboardingFlags(deps.home, prior.autonomyChosen ? { autonomyChosen: true } : {});
  return computeOnboardState(deps);
}
