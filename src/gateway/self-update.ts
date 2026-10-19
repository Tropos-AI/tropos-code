// src/gateway/self-update.ts — a running gateway moves to the version an update installed. Every update moves the
// ~/.local/bin/tcode link the service runs; when it points at a newer version and nothing is busy, the gateway stops
// cleanly and the service manager (launchd KeepAlive, systemd Restart=always) starts the new binary.
import { compareVersions, isVersion } from "../install/version";

export const SELF_UPDATE_EVERY_MS = 5 * 60_000;
/** While a newer version waits for a busy gateway: look again sooner, so it moves soon after the work ends. */
export const SELF_UPDATE_RETRY_MS = 30_000;

export type SelfUpdateOutcome =
  | { kind: "current" }
  /** A newer version is installed but no service would start it again: only a notice. */
  | { kind: "terminal"; version: string }
  | { kind: "busy"; version: string; reason: string }
  | { kind: "restarting"; version: string }
  /** Stopped, or already on its way out. */
  | { kind: "stopped" };

export interface SelfUpdateDeps {
  /** The version this process runs. */
  version: string;
  /** The version the command link resolves to now; null when it isn't an installed version. */
  linked(): string | null;
  /** What keeps the gateway from restarting now (a turn, which includes one waiting for an approval; a job), or null. */
  busy(): string | null | Promise<string | null>;
  /** True when a service manager runs this gateway and starts it again after it exits. */
  supervised(): Promise<boolean>;
  log(line: string): void;
  /** Tells the dashboard's open tabs. */
  notify(text: string): void;
  /** Starts the gateway's clean shutdown; the process then exits 0. */
  exit(version: string): void;
  /** Starts a background update when one is due (a terminal does this when it opens; the gateway has none). */
  checkForUpdates?(): unknown;
  /** Test seam for the timers; returns the cancel function. */
  schedule?(fn: () => void, ms: number): () => void;
}

export interface SelfUpdateWatcher {
  /** Looks once: also run after a reload (SIGUSR2), which another Tropos process sends after it changed things. */
  check(): Promise<SelfUpdateOutcome>;
  start(): void;
  stop(): void;
}

const realSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export function createSelfUpdateWatcher(deps: SelfUpdateDeps): SelfUpdateWatcher {
  const schedule = deps.schedule ?? realSchedule;
  let stopped = false;
  let cancel: (() => void) | undefined;
  let inFlight: Promise<SelfUpdateOutcome> | undefined;
  /** What was already said, so each line appears once per version. */
  const said = new Set<string>();
  const sayOnce = (key: string, line: string) => {
    if (said.has(key)) return;
    said.add(key);
    deps.log(line);
  };

  const newer = (): string | null => {
    let v: string | null;
    try {
      v = deps.linked();
    } catch {
      return null;
    }
    return v && isVersion(v) && isVersion(deps.version) && compareVersions(v, deps.version) > 0 ? v : null;
  };

  async function look(): Promise<SelfUpdateOutcome> {
    if (stopped) return { kind: "stopped" };
    const version = newer();
    if (!version) return { kind: "current" };
    if (!(await deps.supervised().catch(() => false))) {
      sayOnce(`terminal:${version}`, `Tropos Code ${version} is installed; this gateway still runs ${deps.version}. Restart it to use ${version} (ctrl+c, then tcode gateway).`);
      return { kind: "terminal", version };
    }
    const reason = await deps.busy();
    if (reason) {
      sayOnce(`busy:${version}`, `${version} is installed; restarting into it once ${reason} finishes`);
      return { kind: "busy", version, reason };
    }
    if (stopped) return { kind: "stopped" };
    stopped = true;
    cancel?.();
    deps.log(`updating from ${deps.version} to ${version}: stopping so the service starts the new version`);
    deps.notify(`Updating to ${version}… The dashboard reconnects by itself in a few seconds.`);
    deps.exit(version);
    return { kind: "restarting", version };
  }

  const check = (): Promise<SelfUpdateOutcome> => (inFlight ??= look().finally(() => (inFlight = undefined)));

  const arm = (ms: number): void => {
    if (stopped) return;
    cancel = schedule(() => void tick(), ms);
  };

  async function tick(): Promise<void> {
    cancel = undefined;
    try {
      await deps.checkForUpdates?.();
    } catch {
      // The next look tries again; the update log says what went wrong.
    }
    const outcome = await check().catch((): SelfUpdateOutcome => ({ kind: "current" }));
    arm(outcome.kind === "busy" ? SELF_UPDATE_RETRY_MS : SELF_UPDATE_EVERY_MS);
  }

  return {
    check,
    start: () => {
      if (!cancel) arm(SELF_UPDATE_EVERY_MS);
    },
    stop: () => {
      stopped = true;
      cancel?.();
      cancel = undefined;
    },
  };
}
