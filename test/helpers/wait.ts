// test/helpers/wait.ts

/**
 * Retries an assertion until it passes or `timeoutMs` runs out, then throws its last error. UI tests
 * use it instead of fixed sleeps, which flake on slow CI runners (the macOS ones especially).
 */
export async function waitFor(assertion: () => void, timeoutMs = 3000, stepMs = 15): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await Bun.sleep(stepMs);
    }
  }
}

/** A short pause for "nothing should happen" checks and keystroke pacing; longer on CI, where renders lag. */
export const settle = (ms = 40) => Bun.sleep(process.env.CI ? ms * 4 : ms);
