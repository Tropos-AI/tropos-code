// src/cli/shutdown.test.ts
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { closeRuntime } from "./shutdown";

function fake(due: boolean) {
  const calls: string[] = [];
  let finish: () => void = () => {};
  const runtime = {
    finalReviewDue: () => due,
    skipFinalReview: () => {
      calls.push("skip");
      finish();
    },
    shutdown: () => {
      calls.push("shutdown");
      // Like the real one: returns once the final review ends (here: only when skipped).
      return due ? new Promise<void>((r) => (finish = r)) : Promise.resolve();
    },
  };
  return { runtime, calls };
}

test("with nothing to review, it shuts down without a message or a ctrl+c handler", async () => {
  const signals = new EventEmitter();
  const out: string[] = [];
  const { runtime, calls } = fake(false);
  await closeRuntime(runtime, (s) => out.push(s), signals);
  expect(out).toEqual([]);
  expect(calls).toEqual(["shutdown"]);
  expect(signals.listenerCount("SIGINT")).toBe(0);
});

test("ctrl+c during the final review skips it; the shutdown still completes and the handler goes away", async () => {
  const signals = new EventEmitter();
  const out: string[] = [];
  const { runtime, calls } = fake(true);
  const closing = closeRuntime(runtime, (s) => out.push(s), signals);
  expect(out).toEqual(["Saving what I learned before closing… (ctrl+c to skip)\n"]);
  expect(signals.listenerCount("SIGINT")).toBe(1);
  signals.emit("SIGINT");
  await closing;
  expect(calls).toEqual(["shutdown", "skip"]);
  // A second ctrl+c is the default again: it ends the process.
  expect(signals.listenerCount("SIGINT")).toBe(0);
});
