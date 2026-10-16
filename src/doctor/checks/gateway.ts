// src/doctor/checks/gateway.ts — gateway.json parses, the Telegram token is set, the service runs; --deep asks Telegram who the bot is.
import { GatewayConfigError, loadGatewayConfig, telegramToken } from "../../gateway/config";
import type { Check, Finding } from "../types";
import { errorText, finding, isRecord } from "../util";

export const gatewayCheck: Check = {
  id: "gateway.config",
  area: "gateway",
  title: "Gateway configuration and service",
  async run(env) {
    const out: Finding[] = [];
    let token: string | undefined;
    try {
      const config = await loadGatewayConfig(env.home);
      out.push(finding("gateway.config", "ok", "gateway.json is valid"));
      token = telegramToken(config, env.env);
      const fromEnv = Boolean(env.env.TROPOS_TELEGRAM_BOT_TOKEN?.trim());
      out.push(
        token
          ? finding("gateway.telegram", "ok", `Telegram bot token is set (${fromEnv ? "environment" : "gateway.json"})`)
          : finding("gateway.telegram", "info", "No Telegram bot token set", { detail: "Only needed to chat with Tropos through Telegram: set TROPOS_TELEGRAM_BOT_TOKEN." }),
      );
    } catch (err) {
      out.push(finding("gateway.config", "error", err instanceof GatewayConfigError ? err.message : errorText(err)));
    }

    try {
      const s = await env.runner.serviceStatus();
      if (s.manager === "none") out.push(finding("gateway.service", "info", "Running as a background service is not available on this system"));
      else if (!s.installed) out.push(finding("gateway.service", "info", `Gateway service is not installed (${s.manager})`, { detail: "Optional: it keeps the gateway running at login." }));
      else if (!s.running) out.push(finding("gateway.service", "warn", `Gateway service is installed (${s.manager}) but not running`, { detail: s.unitPath }));
      else out.push(finding("gateway.service", "ok", `Gateway service is running (${s.manager}${s.pid ? `, pid ${s.pid}` : ""})`));
    } catch (err) {
      out.push(finding("gateway.service", "warn", "Could not read the gateway service status", { detail: errorText(err) }));
    }

    if (env.deep && token) out.push(await botIdentity(token, env.runner.fetch));
    return out;
  },
};

async function botIdentity(token: string, fetchFn: typeof fetch): Promise<Finding> {
  const redact = (t: string) => t.split(token).join("<token>").split(encodeURIComponent(token)).join("<token>");
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok && isRecord(body) && body.ok === true && isRecord(body.result)) {
      const name = typeof body.result.username === "string" ? `@${body.result.username}` : "(no username)";
      return finding("gateway.telegram.deep", "ok", `Telegram accepts the token: bot ${name}`);
    }
    const why = isRecord(body) && typeof body.description === "string" ? body.description : `HTTP ${res.status}`;
    return finding("gateway.telegram.deep", "error", "Telegram rejected the bot token", { detail: redact(why) });
  } catch (err) {
    return finding("gateway.telegram.deep", "warn", "Could not reach Telegram", { detail: redact(errorText(err)) });
  }
}
