// src/install/recovery.ts
import type { EngineSession } from "./engine";
import { readLink, removeOurLink, switchLink } from "./link";
import type { ReadStateResult } from "./state";
import { checkHealthy, checkVerified, isManaged, listManagedVersions } from "./verify";

export interface RecoveryReport {
  actions: string[];
  /** Set when no verified version can be active (amendment A11: rollback and background updates fail with it). */
  fatal: string | null;
}

const NO_VERIFIED = "no verified Tropos version is installed; reinstall with install.sh";
const FIRST_INSTALL_INCOMPLETE = "installation did not complete; run install.sh again";

/** First Healthy of: current, pending.to, pending.from, previous, then other managed versions newest first (spec §10.6). */
export async function selectFallback(s: EngineSession, exclude: ReadonlySet<string> = new Set()): Promise<string | null> {
  const st = s.state;
  const named = [st.current, st.pending?.to ?? null, st.pending?.from ?? null, st.previous];
  const rest = (await listManagedVersions(s.deps.layout)).filter((v) => st.skip[v] !== "health-check");
  const seen = new Set<string>();
  for (const v of [...named, ...rest]) {
    if (!v || seen.has(v) || exclude.has(v)) continue;
    seen.add(v);
    if ((await checkHealthy(s.ctx, v)).ok) return v;
  }
  return null;
}

/** Never activates a version that is not Healthy; never deletes files (spec §10.6). Runs under the install lock. */
export async function recover(s: EngineSession, read: ReadStateResult): Promise<RecoveryReport> {
  const l = s.deps.layout;
  const actions: string[] = [];
  let fatal: string | null = null;
  const link = await readLink(l);
  const linked = link.kind === "ours" ? link.version : null;
  const linkedManaged = linked !== null && (await isManaged(l, linked));
  const healthy = async (v: string | null): Promise<boolean> => v !== null && (await checkHealthy(s.ctx, v)).ok;

  const toFallback = async (why: string, exclude?: ReadonlySet<string>): Promise<string | null> => {
    const f = await selectFallback(s, exclude);
    if (f) {
      await switchLink(l, f);
      actions.push(`${why}; switched to ${f}`);
      return f;
    }
    if (await removeOurLink(l)) actions.push(`${why}; removed ${l.binLink}`);
    fatal = NO_VERIFIED;
    return null;
  };

  if (read.kind !== "ok") {
    if (read.kind === "missing" && !linkedManaged) return { actions, fatal }; // nothing managed, or a user's local build
    if (read.kind === "corrupt") actions.push(`install state was unreadable (${read.reason}); rebuilt it`);
    const current = linkedManaged && (await healthy(linked)) ? linked : await toFallback("the active version could not be verified");
    let previous: string | null = null;
    for (const v of await listManagedVersions(l)) {
      if (v !== current && (await healthy(v))) {
        previous = v;
        break;
      }
    }
    await s.save({ current, previous, pending: null });
    return { actions, fatal };
  }

  const st = s.state;
  if (st.pending) {
    const { from, to } = st.pending;
    if (linked === to && (await healthy(to))) {
      await s.save({ current: to, previous: from && from !== to ? from : st.previous, pending: null });
      actions.push(`finished the interrupted switch to ${to}`);
    } else if (from !== null && (await healthy(from))) {
      if (linked !== from) await switchLink(l, from);
      await s.save({ current: from, pending: null });
      actions.push(`undid the interrupted switch to ${to}; using ${from}`);
    } else if (from === null) {
      // Only remove a link that points at the half-installed version; an old local-build link stays.
      if ((link.kind === "ours" || link.kind === "dangling-ours") && link.version === to) await removeOurLink(l);
      await s.save({ current: null, pending: null });
      fatal = FIRST_INSTALL_INCOMPLETE;
      actions.push(FIRST_INSTALL_INCOMPLETE);
    } else {
      const f = await toFallback(`the interrupted switch to ${to} could not be completed`, new Set([to]));
      await s.save({ current: f, pending: null });
    }
  } else if (link.kind === "foreign") {
    // Not ours: never touched (spec §4.4).
  } else if (link.kind === "ours" && !linkedManaged && st.current === null) {
    // A local build the user linked themselves.
  } else if (linked !== null && linked !== st.current) {
    if (linkedManaged && (await healthy(linked))) {
      await s.save({ current: linked, previous: (await healthy(st.current)) ? st.current : st.previous });
      actions.push(`adopted ${linked}, which ${l.binLink} points to`);
    } else if (await healthy(st.current)) {
      await switchLink(l, st.current!);
      actions.push(`${l.binLink} pointed to ${linked}, which could not be verified; switched back to ${st.current}`);
    } else {
      await s.save({ current: await toFallback(`${l.binLink} pointed to an unverified version`) });
    }
  } else if (linked !== null) {
    if (!(await healthy(linked))) {
      const f = await toFallback(`${linked} could not be verified`, new Set([linked]));
      await s.save({ current: f, previous: f !== null && f === st.previous ? null : st.previous });
    }
  } else if (st.current !== null || link.kind === "dangling-ours") {
    await s.save({ current: await toFallback(`${l.binLink} was missing`) });
  }

  const prev = s.state.previous;
  if (prev !== null && (prev === s.state.current || !(await checkVerified(s.ctx, prev)).ok)) {
    await s.save({ previous: null });
    actions.push(`previous version ${prev} could not be verified; rollback is unavailable until another version is installed`);
  }
  return { actions, fatal };
}
