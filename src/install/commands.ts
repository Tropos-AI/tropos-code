// src/install/commands.ts
import type { InstallCommand } from "../cli/args";
import { INSTALL_HELP, ROLLBACK_HELP, UPDATE_HELP } from "../cli/usage";
import { runBackgroundUpdate } from "./autoupdate";
import { IS_TEST_BUILD } from "./build-flags";
import type { Channel } from "./channels";
import type { EngineDeps } from "./engine";
import { InstallError, exitCodeFor } from "./errors";
import { installSelf, installTarget, updateChannel } from "./installer";
import { nativeVersionOf, resolveLayout } from "./layout";
import type { LockInfo } from "./locks";
import { detectPlatform } from "./platform";
import type { RecoveryReport } from "./recovery";
import { rollback } from "./rollback";
import { TRUSTED_KEYS } from "./trust";
import { RELEASE_URLS } from "./urls";
import { defaultHealthCheck } from "./verify";

export interface CommandContext {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  execPath: string;
  version: string;
  settings: { autoUpdates: boolean; autoUpdatesChannel: Channel };
  /** Tests inject engine dependencies; production uses productionEngineDeps. */
  engine?: (log: (line: string) => void) => EngineDeps;
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
  if (target === "latest" || target === "stable") return `${lead} To stay on '${target}', set "autoUpdatesChannel": "${target}" in ~/.tropos/settings.json.`;
  return `${lead} To stay on ${target}, set "autoUpdates": false in ~/.tropos/settings.json.`;
}

function describe(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unknown error";
  }
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
  const report = (r: RecoveryReport) => {
    for (const a of r.actions) ctx.err(`tropos: ${a}\n`);
  };
  const onWait = (holder: LockInfo | null) =>
    ctx.err(`tropos: waiting for another Tropos install to finish${holder ? ` (pid ${holder.pid})` : ""}…\n`);

  try {
    const deps = (ctx.engine ?? ((l) => productionEngineDeps(ctx.env, ctx.version, l)))(log);
    if (cmd.kind === "install-self") {
      const run = await installSelf(deps, { kind: "self", execPath: ctx.execPath, manifestPath: cmd.manifest, signaturePath: cmd.signature, compiledVersion: ctx.version });
      report(run.recovery);
      ctx.out(`Installed Tropos Code ${run.value.version}.\n`);
      return 0;
    }
    if (nativeVersionOf(deps.layout, ctx.execPath) === null) {
      throw new InstallError("local", "not a native install; install with install.sh");
    }
    if (background) {
      await runBackgroundUpdate(deps, ctx.settings.autoUpdatesChannel);
      return 0;
    }
    if (cmd.kind === "install") {
      const target = cmd.target ?? "latest";
      const run = await installTarget(deps, target, cmd.force, onWait);
      report(run.recovery);
      ctx.out(run.value.changed ? `Installed Tropos Code ${run.value.version}.\n` : `Tropos Code ${run.value.version} is already installed.\n`);
      const notice = oneTimeInstallNotice(target, ctx.settings);
      if (notice) ctx.out(`${notice}\n`);
      return 0;
    }
    if (cmd.kind === "update") {
      const run = (await updateChannel(deps, ctx.settings.autoUpdatesChannel, { wait: true, onWait }))!;
      report(run.recovery);
      const r = run.value;
      if (r.kind === "updated") ctx.out(`Updated Tropos Code from ${r.outcome.previous ?? "an unmanaged build"} to ${r.outcome.version}.\n`);
      else if (r.kind === "up-to-date") ctx.out(`Tropos Code ${r.current} is up to date (${ctx.settings.autoUpdatesChannel}: ${r.available}).\n`);
      else ctx.out(`Tropos Code ${r.version} is available but skipped because ${SKIP_TEXT[r.reason]}; install it with tropos install ${r.version}.\n`);
      return 0;
    }
    const run = await rollback(deps);
    report(run.recovery);
    ctx.out(`Rolled back from ${run.value.previous} to ${run.value.version}. Background updates will skip ${run.value.previous}.\n`);
    return 0;
  } catch (e) {
    if (background) {
      log(`failed: ${describe(e)}`);
      return 0;
    }
    ctx.err(`tropos: ${describe(e)}\n`);
    return exitCodeFor(e);
  }
}
