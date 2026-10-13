// src/install/recovery.ts
import type { EngineSession } from "./engine";
import { readLink, removeOurLink, switchLink } from "./link";
import type { ReadStateResult } from "./state";
import { checkHealthy, checkVerified, isManaged, listManagedVersions, type Health } from "./verify";

export interface RecoveryReport {
  actions: string[];
  /** Set when no verified version can be active (amendment A11: rollback and background updates fail with it). */
  fatal: string | null;
}

const NO_VERIFIED = "no verified Tropos version is installed; reinstall with install.sh";
const FIRST_INSTALL_INCOMPLETE = "installation did not complete; run install.sh again";

/** "unknown": Verified, but its health check could not be run to a verdict (a transient error, not a broken release). */
type Verdict = "healthy" | "broken" | "unknown";
const verdictOf = (h: Health): Verdict => (h.ok ? "healthy" : h.transient ? "unknown" : "broken");

interface FallbackPick {
  version: string | null;
  /** Candidates whose health check could not be run; they are neither activated nor written off. */
  inconclusive: string[];
}

async function pickFallback(s: EngineSession, exclude: ReadonlySet<string>): Promise<FallbackPick> {
  const st = s.state;
  const named = [st.current, st.pending?.to ?? null, st.pending?.from ?? null, st.previous];
  const rest = (await listManagedVersions(s.deps.layout)).filter((v) => st.skip[v] !== "health-check");
  const seen = new Set<string>();
  const inconclusive: string[] = [];
  for (const v of [...named, ...rest]) {
    if (!v || seen.has(v) || exclude.has(v)) continue;
    seen.add(v);
    const verdict = verdictOf(await checkHealthy(s.ctx, v));
    if (verdict === "healthy") return { version: v, inconclusive };
    if (verdict === "unknown") inconclusive.push(v);
  }
  return { version: null, inconclusive };
}

/** First Healthy of: current, pending.to, pending.from, previous, then other managed versions newest first (spec §10.6). */
export async function selectFallback(s: EngineSession, exclude: ReadonlySet<string> = new Set()): Promise<string | null> {
  return (await pickFallback(s, exclude)).version;
}

/** Removes ~/.local/bin/tropos if it is our symlink — never from a background run, which may be acting on a transient error. */
export async function dropLink(s: EngineSession): Promise<boolean> {
  if (s.background) return false;
  return removeOurLink(s.deps.layout);
}

/**
 * Never activates a version that is not Healthy; never deletes files (spec §10.6). Runs under the install lock.
 * Only a missing/unverified file or a health check that ran and failed counts as broken; a health check that could
 * not be run leaves the active version and the state alone and is reported.
 */
export async function recover(s: EngineSession, read: ReadStateResult): Promise<RecoveryReport> {
  const l = s.deps.layout;
  const actions: string[] = [];
  let fatal: string | null = null;
  const note = (action: string) => {
    actions.push(action);
    s.log(`recovery: ${action}`);
  };
  const link = await readLink(l);
  const linked = link.kind === "ours" ? link.version : null;
  const linkedManaged = linked !== null && (await isManaged(l, linked));
  const health = async (v: string | null): Promise<Verdict> => (v === null ? "broken" : verdictOf(await checkHealthy(s.ctx, v)));
  const inconclusive = (v: string) => note(`the health check of ${v} could not be run; left it in place and changed nothing`);

  /** The new current version, or `undefined` when no candidate could be judged and nothing was changed. */
  const toFallback = async (why: string, exclude: ReadonlySet<string> = new Set()): Promise<string | null | undefined> => {
    const pick = await pickFallback(s, exclude);
    if (pick.version) {
      await switchLink(l, pick.version);
      note(`${why}; switched to ${pick.version}`);
      return pick.version;
    }
    if (pick.inconclusive.length > 0) {
      note(`${why}; the health check of ${pick.inconclusive.join(", ")} could not be run, so nothing was changed`);
      return undefined;
    }
    if (await dropLink(s)) note(`${why}; removed ${l.binLink}`);
    else if (s.background && (link.kind === "ours" || link.kind === "dangling-ours")) note(`${why}; no verified version to switch to, left ${l.binLink} in place`);
    fatal = NO_VERIFIED;
    return null;
  };

  if (link.kind === "foreign") {
    // Not ours: never switched or removed (spec §4.4); only the bookkeeping is settled.
    const pending = read.kind === "ok" && read.state.pending !== null;
    if (read.kind === "corrupt" || pending) {
      if (read.kind === "corrupt") note(`install state was unreadable (${read.reason}); rebuilt it`);
      note(`${l.binLink} is not managed by Tropos; left it alone`);
      await s.save({ pending: null });
    }
    return { actions, fatal };
  }

  if (read.kind !== "ok") {
    if (read.kind === "missing" && !linkedManaged) return { actions, fatal }; // nothing managed, or a user's local build
    if (read.kind === "corrupt") note(`install state was unreadable (${read.reason}); rebuilt it`);
    if (link.kind === "ours" && !linkedManaged) {
      await s.save({ current: null, previous: null, pending: null }); // a local build the user linked: leave the link alone
      return { actions, fatal };
    }
    const lh = linkedManaged ? await health(linked) : "broken";
    let current: string | null;
    if (lh === "healthy") current = linked;
    else if (lh === "unknown") {
      inconclusive(linked!);
      current = linked;
    } else current = (await toFallback("the active version could not be verified")) ?? null;
    let previous: string | null = null;
    for (const v of await listManagedVersions(l)) {
      if (v !== current && (await health(v)) === "healthy") {
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
    const toHealth = linked === to ? await health(to) : "broken";
    if (toHealth === "healthy") {
      await s.save({ current: to, previous: from && from !== to ? from : st.previous, pending: null });
      note(`finished the interrupted switch to ${to}`);
    } else if (toHealth === "unknown") {
      inconclusive(to); // pending stays: a later run decides once the check can run
    } else if (from !== null) {
      const fromHealth = await health(from);
      if (fromHealth === "healthy") {
        if (linked !== from) await switchLink(l, from);
        await s.save({ current: from, pending: null });
        note(`undid the interrupted switch to ${to}; using ${from}`);
      } else if (fromHealth === "unknown" && linked === from) {
        await s.save({ current: from, pending: null });
        inconclusive(from);
      } else {
        const f = await toFallback(`the interrupted switch to ${to} could not be completed`);
        if (f !== undefined) await s.save({ current: f, pending: null });
      }
    } else {
      // Only remove a link that points at the half-installed version; an old local-build link stays.
      if ((link.kind === "ours" || link.kind === "dangling-ours") && link.version === to) await dropLink(s);
      await s.save({ current: null, pending: null });
      fatal = FIRST_INSTALL_INCOMPLETE;
      note(FIRST_INSTALL_INCOMPLETE);
    }
  } else if (link.kind === "ours" && !linkedManaged && st.current === null) {
    // A local build the user linked themselves.
  } else if (linked !== null && linked !== st.current) {
    const lh = linkedManaged ? await health(linked) : "broken";
    if (lh === "healthy") {
      await s.save({ current: linked, previous: (await health(st.current)) === "healthy" ? st.current : st.previous });
      note(`adopted ${linked}, which ${l.binLink} points to`);
    } else if (lh === "unknown") {
      inconclusive(linked);
    } else if ((await health(st.current)) === "healthy") {
      await switchLink(l, st.current!);
      note(`${l.binLink} pointed to ${linked}, which could not be verified; switched back to ${st.current}`);
    } else {
      const f = await toFallback(`${l.binLink} pointed to an unverified version`);
      if (f !== undefined) await s.save({ current: f });
    }
  } else if (linked !== null) {
    const lh = await health(linked);
    if (lh === "unknown") inconclusive(linked);
    else if (lh === "broken") {
      const f = await toFallback(`${linked} could not be verified`, new Set([linked]));
      if (f !== undefined) await s.save({ current: f, previous: f !== null && f === st.previous ? null : st.previous });
    }
  } else if (st.current !== null || link.kind === "dangling-ours") {
    const f = await toFallback(`${l.binLink} was missing`);
    if (f !== undefined) await s.save({ current: f });
  }

  const prev = s.state.previous;
  if (prev !== null && (prev === s.state.current || !(await checkVerified(s.ctx, prev)).ok)) {
    await s.save({ previous: null });
    note(`previous version ${prev} could not be verified; rollback is unavailable until another version is installed`);
  }
  return { actions, fatal };
}
