// src/install/commands.ts
import type { InstallCommand } from "../cli/args";
import { INSTALL_HELP, ROLLBACK_HELP, UPDATE_HELP } from "../cli/usage";
import { runBackgroundUpdate } from "./autoupdate";
import { IS_TEST_BUILD } from "./build-flags";
import type { Channel } from "./channels";
import type { EngineDeps } from "./engine";
import { InstallError, describeError, exitCodeFor } from "./errors";
import { installSelf, installTarget, updateChannel, type Hooks } from "./installer";
import { currentUser, ensureLayout, nativeVersionOf, resolveLayout } from "./layout";
import { lockVersionShared, type LockInfo } from "./locks";
import { detectPlatform } from "./platform";
import type { RecoveryReport } from "./recovery";
import { rollback } from "./rollback";
import { TRUSTED_KEYS } from "./trust";
import { RELEASE_URLS } from "./urls";
import { defaultHealthCheck } from "./verify";
import { migrateCommandLink } from "./session";

export interface CommandContext {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  execPath: string;
  version: string;
  settings: { autoUpdates: boolean; autoUpdatesChannel: Channel };
  /** Tests inject engine dependencies; production uses productionEngineDeps. */
  engine?: (log: (line: string) => void) => EngineDeps;
  /**
   * After an update moved the command to `version`: restarts the background service so it runs it (a background
   * update only nudges the gateway, which restarts itself once idle). Returns a line for the owner. Production:
   * src/cli/after-update.ts.
   */
  afterUpdate?: (version: string, opts: { background: boolean }) => Promise<string | undefined>;
}

export function productionEngineDeps(env: NodeJS.ProcessEnv, version: string, log: (line: string) => void): EngineDeps {
  return {
    layout: resolveLayout(env),
    platform: detectPlatform(),
    trusted: TRUSTED_KEYS,
    urls: RELEASE_URLS,
    health: (bin, v) => defaultHealthCheck(bin, v, env),
    selfVersion: version,
    allowLoopbackHttp: IS_TEST_BUILD,
    log,
  };
}

/** Spec §11 "One-time installs". */
export function oneTimeInstallNotice(target: string, settings: CommandContext["settings"]): string | null {
  if (!settings.autoUpdates || target === settings.autoUpdatesChannel) return null;
  const lead = `Background updates follow the '${settings.autoUpdatesChannel}' channel and may move you to a newer version.`;
  if (target === "latest" || target === "stable") return `${lead} To stay on '${target}', switch the update channel to '${target}' in the dashboard (tcode dashboard).`;
  return `${lead} To stay on ${target}, turn background updates off in the dashboard (tcode dashboard).`;
}

const HELP = { install: INSTALL_HELP, update: UPDATE_HELP, upgrade: UPDATE_HELP, rollback: ROLLBACK_HELP } as const;
const SKIP_TEXT = { "rolled-back": "you rolled back from it", "health-check": "it failed its health check on this machine" } as const;

export async function runInstallCommand(cmd: InstallCommand, ctx: CommandContext): Promise<number> {
  if (cmd.kind === "help") {
    ctx.out(HELP[cmd.command]);
    return 0;
  }
  const background = cmd.kind === "update" && cmd.background;
  const log = (line: string) => {
    if (background) ctx.out(`${new Date().toISOString()} ${line}\n`);
  };
  // Printed as soon as recovery has run, so its actions show even when the command then fails (A11: install and
  // update also print the fatal condition and carry on; rollback fails with it, which the catch below prints).
  const report = (r: RecoveryReport) => {
    for (const a of r.actions) ctx.err(`tcode: ${a}\n`);
    if (r.fatal && cmd.kind !== "rollback" && cmd.kind !== "install-self" && !r.actions.includes(r.fatal)) ctx.err(`tcode: ${r.fatal}\n`);
  };
  const onWait = (holder: LockInfo | null) =>
    ctx.err(`tcode: waiting for another Tropos install to finish${holder ? ` (pid ${holder.pid})` : ""}…\n`);
  const hooks: Hooks = { onWait, onRecovery: report };

  try {
    const base = (ctx.engine ?? ((l) => productionEngineDeps(ctx.env, ctx.version, l)))(log);
    const deps = { ...base, user: base.user ?? currentUser() };
    // An install from before 0.3.0 has only `tropos`: add `tcode` quietly first, instead of recovery
    // reporting it "missing" (install --self links tcode itself).
    if (cmd.kind !== "install-self") await migrateCommandLink(deps.layout);
    if (cmd.kind === "install-self") {
      // Runs from install.sh's temporary folder: there is no installed version of ours to hold (spec §10.1).
      const run = await installSelf(deps, { kind: "self", execPath: ctx.execPath, manifestPath: cmd.manifest, signaturePath: cmd.signature, compiledVersion: ctx.version }, hooks);
      ctx.out(`Installed Tropos Code ${run.value.version}.\n`);
      return 0;
    }
    const running = nativeVersionOf(deps.layout, ctx.execPath);
    if (running === null) {
      throw new InstallError("local", "not a native install; install with install.sh");
    }
    // Spec §10.1: like any session, a command holds the in-use lock of the version it runs from, so neither its
    // own cleanup nor a damaged-file replacement can remove the binary that is running.
    await ensureLayout(deps.layout, deps.user);
    const inUse = await lockVersionShared(deps.layout, running, { flock: deps.flock });
    if (!inUse) log(`could not take the in-use lock of ${running}; continuing`);
    try {
      return await runNative(cmd, ctx, { ...deps, runningVersion: running }, hooks);
    } finally {
      inUse?.release();
    }
  } catch (e) {
    if (background) {
      log(`failed: ${describeError(e)}`);
      return 0;
    }
    ctx.err(`tcode: ${describeError(e)}\n`);
    return exitCodeFor(e);
  }
}

/** The update is in place whatever happens here: a failed restart is reported, never turned into a failed update. */
async function restartAfter(ctx: CommandContext, version: string): Promise<void> {
  if (!ctx.afterUpdate) return;
  try {
    const line = await ctx.afterUpdate(version, { background: false });
    if (line) ctx.out(`${line}\n`);
  } catch (e) {
    ctx.err(`tcode: ${version} is installed, but the background service could not be restarted: ${describeError(e)}. Restart it with: tcode gateway restart\n`);
  }
}

async function runNative(cmd: Exclude<InstallCommand, { kind: "help" | "install-self" }>, ctx: CommandContext, deps: EngineDeps, hooks: Hooks): Promise<number> {
  if (cmd.kind === "update" && cmd.background) {
    const to = await runBackgroundUpdate(deps, ctx.settings.autoUpdatesChannel);
    if (to && ctx.afterUpdate) {
      try {
        const line = await ctx.afterUpdate(to, { background: true });
        if (line) deps.log?.(line);
      } catch (e) {
        deps.log?.(`after the update: ${describeError(e)}`);
      }
    }
    return 0;
  }
  if (cmd.kind === "install") {
    const target = cmd.target ?? "latest";
    const run = await installTarget(deps, target, cmd.force, hooks);
    ctx.out(run.value.changed ? `Installed Tropos Code ${run.value.version}.\n` : `Tropos Code ${run.value.version} is already installed.\n`);
    const notice = oneTimeInstallNotice(target, ctx.settings);
    if (notice) ctx.out(`${notice}\n`);
    return 0;
  }
  if (cmd.kind === "update") {
    const run = (await updateChannel(deps, ctx.settings.autoUpdatesChannel, { wait: true, ...hooks }))!;
    const r = run.value;
    if (r.kind === "updated") {
      ctx.out(`Updated Tropos Code from ${r.outcome.previous ?? "an unmanaged build"} to ${r.outcome.version}.\n`);
      if (r.outcome.changed) await restartAfter(ctx, r.outcome.version);
    } else if (r.kind === "up-to-date") ctx.out(`Tropos Code ${r.current} is up to date (${ctx.settings.autoUpdatesChannel}: ${r.available}).\n`);
    else ctx.out(`Tropos Code ${r.version} is available but skipped because ${SKIP_TEXT[r.reason]}; install it with tcode install ${r.version}.\n`);
    return 0;
  }
  const run = await rollback(deps, hooks);
  ctx.out(`Rolled back from ${run.value.previous} to ${run.value.version}. Background updates will skip ${run.value.previous}.\n`);
  return 0;
}
