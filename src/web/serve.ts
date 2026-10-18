// src/web/serve.ts — helpers for opening the dashboard: the default browser, and waiting for a signal.

/** Opens the default browser; a failure just leaves the printed link. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform, spawn: typeof Bun.spawn = Bun.spawn): void {
  const argv = platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {
    // no opener: the link is printed anyway
  }
}

/** Resolves on ctrl+c or a termination signal. */
export function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}
