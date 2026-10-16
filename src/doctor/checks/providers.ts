// src/doctor/checks/providers.ts — at least one provider can be used; with --deep each is asked for its model list.
import { readSettingsFile, type ProviderSetting } from "../../config/settings";
import { CredentialsError, readCredentials, resolveApiKey, type StoredCredentials } from "../../providers/credentials";
import { ProviderRouter } from "../../providers/router";
import type { Check, Finding } from "../types";
import { errorText, finding } from "../util";

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

async function userProviders(home: string): Promise<Record<string, ProviderSetting>> {
  try {
    return (await readSettingsFile(`${home}/settings.json`))?.providers ?? {};
  } catch {
    return {}; // the settings check reports it
  }
}

/** A keyless local provider only counts when something answers on its port (a quick loopback request). */
async function localServerUp(fetchFn: typeof fetch, baseURL: string): Promise<boolean> {
  try {
    return (await fetchFn(`${baseURL.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(1_500) })).ok;
  } catch {
    return false;
  }
}

export const providersCheck: Check = {
  id: "providers.keys",
  area: "providers",
  title: "A model provider is usable",
  async run(env) {
    const out: Finding[] = [];
    let saved: StoredCredentials = {};
    try {
      saved = await readCredentials(env.home);
    } catch (err) {
      out.push(finding("providers.credentials", "error", "credentials.json cannot be read", { detail: errorText(err) }));
    }
    const settings = await userProviders(env.home);
    const router = new ProviderRouter({ home: env.home, env: env.env, settings });
    const usable: Array<{ id: string; name: string; how: string }> = [];
    const secrets: string[] = [];
    for (const info of router.list()) {
      const key = resolveApiKey(info.keyEnv, info.id, env.env, saved);
      if (key) {
        secrets.push(key.apiKey);
        usable.push({ id: info.id, name: info.name, how: key.source.kind === "env" ? `$${key.source.name}` : "credentials.json" });
      } else if (!info.keyRequired && info.id !== "anthropic" && LOCAL.test(router.baseURL(info)) && (await localServerUp(env.runner.fetch, router.baseURL(info)))) {
        usable.push({ id: info.id, name: info.name, how: "local, no key needed" });
      }
    }
    if (usable.length === 0) {
      out.push(
        finding("providers.keys", "error", "No model provider is set up", {
          detail: "Run `tcode`, then /providers to connect one, or set a key such as ANTHROPIC_API_KEY. A local Ollama or LM Studio also works.",
        }),
      );
      return out;
    }
    out.push(finding("providers.keys", "ok", `${usable.length} provider${usable.length === 1 ? "" : "s"} usable: ${usable.map((u) => `${u.id} (${u.how})`).join(", ")}`));
    if (!env.deep) return out;

    const redact = (text: string) => secrets.reduce((t, s) => (s ? t.split(s).join("<key>") : t), text);
    const results = await Promise.all(
      usable.map(async (u) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10_000);
        try {
          const models = await env.runner.listModels({ home: env.home, env: env.env, settings, id: u.id, signal: ctl.signal });
          return finding(`providers.deep.${u.id}`, "ok", `${u.name}: authenticated, ${models.length} model${models.length === 1 ? "" : "s"} listed`);
        } catch (err) {
          return finding(`providers.deep.${u.id}`, "warn", `${u.name}: the model listing failed`, { detail: redact(errorText(err)) });
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return [...out, ...results];
  },
};
