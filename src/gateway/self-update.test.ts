import { describe, expect, test } from "bun:test";
import { SELF_UPDATE_EVERY_MS, SELF_UPDATE_RETRY_MS, createSelfUpdateWatcher, type SelfUpdateDeps } from "./self-update";

/** A fake clock: `schedule` records timers, `advance` fires the due ones in order. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    schedule(fn: () => void, ms: number) {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return () => void (timers = timers.filter((t) => t.id !== id));
    },
    pending: () => timers.map((t) => t.at - now),
    async advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        due.fn();
        // Let the async tick (and the check it runs) settle.
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
    },
  };
}

function setup(over: Partial<SelfUpdateDeps> = {}) {
  const clock = fakeClock();
  const logs: string[] = [];
  const notices: string[] = [];
  const exits: string[] = [];
  const state = { linked: "0.5.2" as string | null, busy: null as string | null, supervised: true, checks: 0 };
  const watcher = createSelfUpdateWatcher({
    version: "0.5.2",
    linked: () => state.linked,
    busy: () => state.busy,
    supervised: async () => state.supervised,
    log: (l) => logs.push(l),
    notify: (t) => notices.push(t),
    exit: (v) => exits.push(v),
    checkForUpdates: () => void state.checks++,
    schedule: clock.schedule,
    ...over,
  });
  return { watcher, clock, logs, notices, exits, state };
}

describe("the gateway's self-update", () => {
  test("nothing happens while the link still points at the running version, or at an older one", async () => {
    const t = setup();
    expect(await t.watcher.check()).toEqual({ kind: "current" });
    t.state.linked = "0.5.1";
    expect(await t.watcher.check()).toEqual({ kind: "current" });
    t.state.linked = null;
    expect(await t.watcher.check()).toEqual({ kind: "current" });
    expect([...t.logs, ...t.notices, ...t.exits]).toEqual([]);
  });

  test("a newer version under a service, idle: it logs, tells the dashboard and exits so the service starts the new binary", async () => {
    const t = setup();
    t.state.linked = "0.6.0";
    expect(await t.watcher.check()).toEqual({ kind: "restarting", version: "0.6.0" });
    expect(t.logs.join("\n")).toContain("updating from 0.5.2 to 0.6.0");
    expect(t.notices).toEqual(["Updating to 0.6.0… The dashboard reconnects by itself in a few seconds."]);
    expect(t.exits).toEqual(["0.6.0"]);
    // Once on its way out it never exits twice.
    expect(await t.watcher.check()).toEqual({ kind: "stopped" });
    expect(t.exits).toEqual(["0.6.0"]);
  });

  test("a busy gateway waits: no exit while a turn, an approval or a job runs; it restarts once idle", async () => {
    const t = setup();
    t.state.linked = "0.6.0";
    t.state.busy = "a chat's turn";
    expect(await t.watcher.check()).toEqual({ kind: "busy", version: "0.6.0", reason: "a chat's turn" });
    expect(await t.watcher.check()).toMatchObject({ kind: "busy" });
    expect(t.exits).toEqual([]);
    expect(t.notices).toEqual([]);
    // Said once per version, not at every look.
    expect(t.logs).toEqual(["0.6.0 is installed; restarting into it once a chat's turn finishes"]);
    t.state.busy = null;
    expect(await t.watcher.check()).toEqual({ kind: "restarting", version: "0.6.0" });
    expect(t.exits).toEqual(["0.6.0"]);
  });

  test("in a terminal without a service it only prints a one-line notice, once per version, and never exits", async () => {
    const t = setup();
    t.state.supervised = false;
    t.state.linked = "0.6.0";
    expect(await t.watcher.check()).toEqual({ kind: "terminal", version: "0.6.0" });
    expect(await t.watcher.check()).toEqual({ kind: "terminal", version: "0.6.0" });
    expect(t.logs).toEqual(["Tropos Code 0.6.0 is installed; this gateway still runs 0.5.2. Restart it to use 0.6.0 (ctrl+c, then tcode gateway)."]);
    t.state.linked = "0.6.1";
    await t.watcher.check();
    expect(t.logs).toHaveLength(2);
    expect(t.exits).toEqual([]);
    expect(t.notices).toEqual([]);
  });

  test("a version that doesn't parse is never treated as newer", async () => {
    const t = setup();
    t.state.linked = "0.6.0-beta";
    expect(await t.watcher.check()).toEqual({ kind: "current" });
  });

  test("looks every 5 minutes, sooner while an update waits for a busy gateway, and starts a due update check each time", async () => {
    const t = setup();
    t.watcher.start();
    expect(t.clock.pending()).toEqual([SELF_UPDATE_EVERY_MS]);
    await t.clock.advance(SELF_UPDATE_EVERY_MS);
    expect(t.state.checks).toBe(1);
    expect(t.clock.pending()).toEqual([SELF_UPDATE_EVERY_MS]);
    t.state.linked = "0.6.0";
    t.state.busy = "a scheduled job";
    await t.clock.advance(SELF_UPDATE_EVERY_MS);
    expect(t.clock.pending()).toEqual([SELF_UPDATE_RETRY_MS]);
    expect(SELF_UPDATE_RETRY_MS).toBeLessThan(SELF_UPDATE_EVERY_MS);
    t.state.busy = null;
    await t.clock.advance(SELF_UPDATE_RETRY_MS);
    expect(t.exits).toEqual(["0.6.0"]);
    // On its way out: nothing more is scheduled.
    expect(t.clock.pending()).toEqual([]);
  });

  test("stop cancels the timer; a failing update check or version lookup never stops the watching", async () => {
    const t = setup({
      checkForUpdates: () => {
        throw new Error("no network");
      },
    });
    t.watcher.start();
    await t.clock.advance(SELF_UPDATE_EVERY_MS);
    expect(t.clock.pending()).toEqual([SELF_UPDATE_EVERY_MS]);
    t.watcher.stop();
    expect(t.clock.pending()).toEqual([]);
    expect(await t.watcher.check()).toEqual({ kind: "stopped" });

    const broken = setup({
      linked: () => {
        throw new Error("EACCES");
      },
    });
    expect(await broken.watcher.check()).toEqual({ kind: "current" });
  });
});
