// src/cli/shutdown.ts
import type { Runtime } from "../ui/runtime";

export interface SignalSource {
  once(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

/**
 * Ends the terminal session. When the final learning review will hold the terminal (up to 30 s) it says so, and
 * ctrl+c skips the review instead of killing the process, so SessionEnd hooks still run and servers still close.
 * The handler fires once: a second ctrl+c ends the process as usual.
 */
export async function closeRuntime(
  runtime: Pick<Runtime, "finalReviewDue" | "skipFinalReview" | "shutdown">,
  err: (text: string) => void,
  signals: SignalSource = process,
): Promise<void> {
  if (!runtime.finalReviewDue()) return runtime.shutdown();
  err("Saving what I learned before closing… (ctrl+c to skip)\n");
  const skip = () => runtime.skipFinalReview();
  signals.once("SIGINT", skip);
  try {
    await runtime.shutdown();
  } finally {
    signals.off("SIGINT", skip);
  }
}
