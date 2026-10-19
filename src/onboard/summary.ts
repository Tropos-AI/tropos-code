// src/onboard/summary.ts — what the last step of setup tells the owner: what is ready, where to go, what to try.
import { loadGatewayConfig, telegramToken } from "../gateway/config";
import { TelegramApi } from "../gateway/telegram/api";
import { dashboardPort } from "../web/links";
import { DEFAULT_PORT } from "../web/protocol";
import type { SetupSummaryView } from "../web/admin/api";
import { exampleAsks } from "./copy";
import { computeOnboardState, healthReport, type OnboardDeps } from "./engine";

const MAX_PROBLEMS = 5;
const GET_ME_TIMEOUT_MS = 8_000;

/** The bot's @name from Telegram with the saved token; null when there is no token or Telegram does not answer. */
export async function botUsername(deps: OnboardDeps): Promise<string | null> {
  try {
    const token = telegramToken(await loadGatewayConfig(deps.home), deps.env);
    if (!token) return null;
    const api = new TelegramApi({ token, fetch: deps.fetch, baseUrl: deps.telegramBaseUrl });
    return (await api.getMe(AbortSignal.timeout(GET_ME_TIMEOUT_MS))).username || null;
  } catch {
    return null;
  }
}

export async function setupSummary(deps: OnboardDeps): Promise<SetupSummaryView> {
  const config = await loadGatewayConfig(deps.home).catch(() => null);
  // The doctor runs once, here; the checklist is read without it.
  const [state, report, bot] = await Promise.all([computeOnboardState(deps, { health: false }), healthReport(deps).catch(() => null), botUsername(deps)]);
  const problems = (report?.findings ?? []).filter((f) => f.level === "warn" || f.level === "error").slice(0, MAX_PROBLEMS).map((f) => f.message);
  return {
    steps: state.steps.filter((s) => s.id !== "welcome" && s.id !== "done").map(({ id, title, status, detail }) => ({ id, title, status, ...(detail ? { detail } : {}) })),
    dashboardUrl: `http://127.0.0.1:${config ? dashboardPort(config) : DEFAULT_PORT}`,
    ...(bot ? { botUrl: `https://t.me/${bot}` } : {}),
    examples: exampleAsks(config?.projects[0]?.name),
    health: { ok: report?.summary.ok ?? 0, warn: report?.summary.warn ?? 0, error: report?.summary.error ?? 0, problems },
  };
}
