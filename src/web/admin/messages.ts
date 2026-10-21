// src/web/admin/messages.ts — `messages.*`: texts (the Messages and SendIMessage tools) on or off, and the two macOS
// permissions the helper needs. The switch is the `messages` key of the user's settings.json; macOS only.
import { ConfigStoreError, configFile, readConfigRaw, setAt, updateConfigFile } from "../../config/store";
import type { Exec } from "../../messages/helper/install";
import { resolveLayout } from "../../install/layout";
import { createMessagesRuntime, type MessagesRuntime } from "../../messages/runtime";
import type { MessagesView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

/** What the handlers reach outside for; tests pass fakes so nothing touches Messages, the helper or ~/Library. */
export interface MessagesDeps {
  platform?: NodeJS.Platform;
  /** One runtime per call; the handler disposes it when the call ends. */
  runtime?: () => MessagesRuntime;
  /** Runs `open` for the System Settings panes. */
  exec?: Exec;
}

const PANES = {
  fda: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
} as const;

const MACOS_ONLY = "Texts are only available on macOS.";

export function messagesHandlers(ctx: AdminContext, deps: MessagesDeps = {}): AdminHandlers {
  const platform = deps.platform ?? process.platform;
  const runtime = deps.runtime ?? (() => createMessagesRuntime({ home: ctx.home, userHome: ctx.userHome, layout: resolveLayout(ctx.env, ctx.userHome) }));
  const darwin = (): void => {
    if (platform !== "darwin") throw new AdminError(MACOS_ONLY);
  };
  const enabled = async (): Promise<boolean> => {
    const raw = await readConfigRaw(configFile(ctx.home, "settings")).catch((err) => {
      throw new AdminError(err instanceof Error ? err.message : "Cannot read settings.json.");
    });
    return raw.messages === true;
  };
  /** The view, with the setup status when texts are on; the runtime is closed again before returning. */
  const view = async (probe: boolean): Promise<MessagesView> => {
    if (platform !== "darwin") return { available: false, enabled: false };
    const on = await enabled();
    if (!on) return { available: true, enabled: false };
    const rt = runtime();
    try {
      // The live check ("I can see 37 chats") counts from one snapshot once Full Disk Access is on.
      return { available: true, enabled: true, status: await rt.status({ probe, chats: true }) };
    } finally {
      rt.dispose();
    }
  };

  return {
    "messages.get": () => view(false),

    async "messages.set"(params) {
      darwin();
      if (params === null || typeof params !== "object" || typeof params.enabled !== "boolean") throw new AdminError("Say whether texts should be on or off.");
      if (params.enabled) {
        const rt = runtime();
        try {
          await rt.enable();
        } catch (err) {
          throw new AdminError(`Could not set up the Messages helper: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}`);
        } finally {
          rt.dispose();
        }
      }
      try {
        await updateConfigFile(configFile(ctx.home, "settings"), (draft) => setAt(draft, ["messages"], params.enabled));
      } catch (err) {
        if (err instanceof ConfigStoreError) throw new AdminError(err.message);
        throw err;
      }
      const reloaded = await ctx.gateway?.reload().then(() => true, () => false);
      const out = await view(false);
      return reloaded === false ? { ...out, note: "Saved; restart the service for running chats to pick it up." } : out;
    },

    async "messages.openSettings"(params) {
      darwin();
      const url = params && typeof params === "object" ? PANES[params.pane as keyof typeof PANES] : undefined;
      if (!url) throw new AdminError("Say which pane: fda or automation.");
      const exec = deps.exec ?? (await defaultExec());
      const r = await exec("/usr/bin/open", [url], 10_000);
      if (r.code !== 0) throw new AdminError("Could not open System Settings.");
      return { ok: true };
    },

    /** Asks Messages now, which shows macOS's Automation prompt the first time. */
    "messages.probe"() {
      darwin();
      return view(true);
    },
  };
}

async function defaultExec(): Promise<Exec> {
  const { defaultRunner } = await import("../../doctor/runner");
  return async (cmd, args, timeoutMs) => {
    const r = await defaultRunner().exec(cmd, args, timeoutMs);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr || r.error || "" };
  };
}
