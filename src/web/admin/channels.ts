// src/web/admin/channels.ts — `channels.*`: the Telegram bot token. The token is write-only: it is checked with getMe
// before anything is saved and is never returned, logged or put in an error message.
import { loadGatewayConfig, saveGatewayConfig, telegramToken } from "../../gateway/config";
import { TelegramApi } from "../../gateway/telegram/api";
import type { TelegramInfo } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { messageOf, scrub } from "./util";

export interface ChannelsDeps {
  /** Reaches api.telegram.org; tests replace it. Defaults to the context's fetch. */
  fetch: typeof fetch;
}

export function channelsHandlers(ctx: AdminContext, deps: Partial<ChannelsDeps> = {}): AdminHandlers {
  const fetchFn = deps.fetch ?? ctx.fetch;
  const envToken = () => ctx.env.TROPOS_TELEGRAM_BOT_TOKEN?.trim() || undefined;

  const info = async (bot?: TelegramInfo["bot"]): Promise<TelegramInfo> => {
    const config = await loadGatewayConfig(ctx.home).catch(() => null);
    const token = config ? telegramToken(config, ctx.env) : envToken();
    return { configured: Boolean(token), source: !token ? null : envToken() ? "env" : "file", ...(bot ? { bot } : {}) };
  };

  /** getMe with the token, turning any failure into a message without the token in it. */
  const whoAmI = async (token: string): Promise<{ ok: true; bot: { username: string; name: string } } | { ok: false; error: string }> => {
    const api = new TelegramApi({ token, fetch: fetchFn });
    try {
      return { ok: true, bot: await api.getMe(AbortSignal.timeout(10_000)) };
    } catch (err) {
      return { ok: false, error: scrub(api.redact(messageOf(err)), [token]) };
    }
  };

  const reload = async () => {
    await ctx.gateway?.reload().catch(() => undefined);
  };

  return {
    "channels.get": async () => ({ telegram: await info() }),
    "channels.telegram.set": async (params) => {
      const token = typeof params?.token === "string" ? params.token.trim() : "";
      if (!token) throw new AdminError("Paste the bot token from @BotFather.");
      if (/\s/.test(token)) throw new AdminError("A bot token has no spaces. Paste only the token.");
      const who = await whoAmI(token);
      if (!who.ok) throw new AdminError(`Telegram did not accept that token: ${who.error}`);
      const config = await loadGatewayConfig(ctx.home).catch((err: unknown) => {
        throw new AdminError(scrub(messageOf(err), [token]));
      });
      await saveGatewayConfig(ctx.home, { ...config, telegram: { ...config.telegram, botToken: token } });
      await reload();
      return info(who.bot);
    },
    "channels.telegram.clear": async () => {
      const config = await loadGatewayConfig(ctx.home).catch((err: unknown) => {
        throw new AdminError(scrub(messageOf(err)));
      });
      const { botToken: _gone, ...rest } = config.telegram;
      await saveGatewayConfig(ctx.home, { ...config, telegram: rest });
      await reload();
      return info();
    },
    "channels.telegram.test": async () => {
      const config = await loadGatewayConfig(ctx.home).catch(() => null);
      const token = config ? telegramToken(config, ctx.env) : envToken();
      if (!token) return { ok: false, error: "No bot token is set." };
      const who = await whoAmI(token);
      return who.ok ? { ok: true, bot: who.bot } : { ok: false, error: who.error };
    },
  };
}
