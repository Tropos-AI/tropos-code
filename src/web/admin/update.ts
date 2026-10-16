// src/web/admin/update.ts — `update.*`: the release channel through the install engine. Status reads local state only;
// check asks the channel; run is the same install as `tcode update`, with its output captured.
import { readUserSettingsRaw, updateUserSettings } from "../../config/store";
import { checkForUpdate } from "../../install/check";
import { isChannel, type Channel } from "../../install/channels";
import { productionEngineDeps, runInstallCommand, type CommandContext } from "../../install/commands";
import type { EngineDeps } from "../../install/engine";
import { describeError } from "../../install/errors";
import { resolveLayout } from "../../install/layout";
import { readState } from "../../install/state";
import { compareVersions, isVersion } from "../../install/version";
import type { UpdateStatus } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { scrub } from "./util";

export interface UpdateDeps {
  /** The install engine's dependencies (layout, platform, trusted keys, release URLs, fetch). */
  engine(ctx: AdminContext, log: (line: string) => void): EngineDeps;
  /** `tcode update`, with its output handed to `cmdCtx.out/err`. */
  install(cmdCtx: CommandContext): Promise<number>;
  check: typeof checkForUpdate;
}

const OUTPUT_MAX = 2000;

export function updateHandlers(ctx: AdminContext, deps: Partial<UpdateDeps> = {}): AdminHandlers {
  const engine = deps.engine ?? ((c: AdminContext, log: (line: string) => void) => ({ ...productionEngineDeps(c.env, c.version, log), layout: resolveLayout(c.env, c.userHome), fetch: c.fetch }));
  const install = deps.install ?? ((cmdCtx: CommandContext) => runInstallCommand({ kind: "update", background: false, alias: "update" }, cmdCtx));
  const check = deps.check ?? checkForUpdate;
  const layout = resolveLayout(ctx.env, ctx.userHome);

  let running = false;
  /** The newest version this process has seen the channel announce; nothing is stored for it on disk. */
  let latest: string | undefined;

  async function settings(): Promise<{ channel: Channel; autoUpdates: boolean }> {
    const raw = await readUserSettingsRaw(ctx.home).catch(() => ({}) as Record<string, unknown>);
    const channel = typeof raw.autoUpdatesChannel === "string" && isChannel(raw.autoUpdatesChannel) ? raw.autoUpdatesChannel : "latest";
    return { channel, autoUpdates: raw.autoUpdates !== false };
  }

  async function status(): Promise<UpdateStatus> {
    const [s, state] = await Promise.all([settings(), readState(layout).catch(() => ({ kind: "missing" as const }))]);
    const checkedAt = state.kind === "ok" ? (state.state.autoUpdate.lastCheck ?? undefined) : undefined;
    return {
      current: ctx.version,
      channel: s.channel,
      ...(latest ? { latest } : {}),
      available: latest !== undefined && isVersion(latest) && isVersion(ctx.version) && compareVersions(latest, ctx.version) > 0,
      ...(checkedAt ? { checkedAt } : {}),
      autoUpdates: s.autoUpdates,
      ...(running ? { running: true } : {}),
    };
  }

  return {
    "update.status": () => status(),

    async "update.check"() {
      const { channel } = await settings();
      const d = engine(ctx, () => undefined);
      try {
        const r = await check({ ...d, now: () => new Date(ctx.now()) }, channel, ctx.version);
        latest = r.latest;
      } catch (err) {
        throw new AdminError(`Couldn't check for updates: ${scrub(describeError(err))}`);
      }
      return status();
    },

    async "update.run"() {
      const from = ctx.version;
      if (running) return { ok: false, from, message: "An update is already running." };
      running = true;
      let out = "";
      let errText = "";
      try {
        const s = await settings();
        const code = await install({
          out: (t) => void (out += t),
          err: (t) => void (errText += t),
          env: ctx.env,
          execPath: ctx.execPath,
          version: ctx.version,
          settings: { autoUpdates: s.autoUpdates, autoUpdatesChannel: s.channel },
          engine: (log) => engine(ctx, log),
        });
        const message = scrub((code === 0 ? out || errText : errText || out).trim()).slice(0, OUTPUT_MAX) || (code === 0 ? "Done." : "The update failed.");
        if (code !== 0) return { ok: false, from, message };
        const to = /\bto (\d+\.\d+\.\d+)\b/.exec(out)?.[1] ?? /Tropos Code (\d+\.\d+\.\d+) is up to date/.exec(out)?.[1];
        if (to) latest = to;
        return { ok: true, from, ...(to ? { to } : {}), message };
      } catch (err) {
        return { ok: false, from, message: scrub(describeError(err)).slice(0, OUTPUT_MAX) };
      } finally {
        running = false;
      }
    },

    async "update.setChannel"({ channel }) {
      if (!isChannel(channel)) throw new AdminError('The channel is "latest" or "stable".');
      await updateUserSettings(ctx.home, { autoUpdatesChannel: channel });
      // What the old channel announced says nothing about the new one.
      latest = undefined;
      return status();
    },

    async "update.setAuto"({ enabled }) {
      if (typeof enabled !== "boolean") throw new AdminError("enabled must be true or false.");
      await updateUserSettings(ctx.home, { autoUpdates: enabled });
      return status();
    },
  };
}
