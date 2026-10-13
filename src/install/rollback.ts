// src/install/rollback.ts
import { withInstallLock, type EngineDeps, type LockedRun } from "./engine";
import { InstallError } from "./errors";
import { healthNotRun, preSwitchChecks, type Hooks, type InstallOutcome } from "./installer";
import { linkResolvesTo, readLink, switchLink } from "./link";
import { dropLink, selectFallback } from "./recovery";
import { checkHealthy, listManagedVersions } from "./verify";

/** Spec §10.7: only to a Healthy `previous`; the version rolled back from is skipped by background updates. */
export async function rollback(deps: EngineDeps, hooks: Hooks = {}): Promise<LockedRun<InstallOutcome>> {
  const run = await withInstallLock(deps, { wait: true, ...hooks }, async (s, recovery) => {
    if (recovery.fatal) throw new InstallError("integrity", recovery.fatal);
    const l = deps.layout;
    const current = s.state.current;
    const previous = s.state.previous;
    if (previous === null || !(await checkHealthy(s.ctx, previous)).ok) {
      const healthy: string[] = [];
      for (const v of await listManagedVersions(l)) if (v !== current && (await checkHealthy(s.ctx, v)).ok) healthy.push(v);
      const hint = healthy.length ? `; verified versions: ${healthy.join(", ")} — install one with tropos install <version>` : "";
      throw new InstallError("integrity", `no verified previous version to roll back to${hint}`);
    }
    await preSwitchChecks(s, await readLink(l), false, "move");
    await s.save({ pending: { op: "switch", from: current, to: previous } });
    s.crash("after-pending");
    await switchLink(l, previous);
    s.crash("after-swap");
    const post = (await linkResolvesTo(l, previous)) ? await deps.health(l.binLink, previous) : "bad";
    if (post !== "ok") {
      const restored = current !== null && (await checkHealthy(s.ctx, current)).ok ? current : await selectFallback(s, new Set([previous]));
      if (restored) await switchLink(l, restored);
      else await dropLink(s);
      const using = restored ? `still using ${restored}` : "no verified version is active";
      if (post === "unknown") {
        await s.save({ current: restored, pending: null });
        throw healthNotRun(previous, using);
      }
      await s.save({ current: restored, pending: null, skip: { ...s.state.skip, [previous]: "health-check" } });
      throw new InstallError("integrity", `version ${previous} failed its check; ${using}`);
    }
    const skip = current !== null ? { ...s.state.skip, [current]: "rolled-back" as const } : s.state.skip;
    await s.save({ current: previous, previous: current, pending: null, skip });
    s.crash("after-state");
    return { version: previous, previous: current, changed: true };
  });
  return run!;
}
