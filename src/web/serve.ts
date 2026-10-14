// src/web/serve.ts — `tcode web`: the session behind a local browser UI until ctrl+c.
import { randomBytes } from "node:crypto";
import type { WebOptions } from "../cli/args";
import type { Mode } from "../config/constants";
import type { SessionStore, MessageParam } from "../session/store";
import { DARK } from "../ui/theme";
import { createRuntime, type AppContext } from "../cli/runtime";
import { loadAssets, type AssetMap } from "./assets";
import { WebHost } from "./host";
import { DEFAULT_PORT } from "./protocol";
import { startWebServer, type RunningWebServer } from "./server";

export interface RunWebOptions {
  session: SessionStore;
  history: MessageParam[];
  mode: Mode;
  modes: Mode[];
  source: "startup" | "resume";
  web: WebOptions;
  out(text: string): void;
  err(text: string): void;
  /** Tests stop the server themselves instead of waiting for a signal; they also skip the browser. */
  until?: (server: RunningWebServer) => Promise<void>;
  openBrowser?: (url: string) => void;
  assets?: AssetMap;
}

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

export async function runWeb(ctx: AppContext, o: RunWebOptions): Promise<number> {
  const runtime = await createRuntime(ctx, {
    session: o.session,
    history: o.history,
    mode: o.mode,
    modes: o.modes,
    theme: DARK,
    source: o.source,
  });
  const host = new WebHost(runtime);
  await host.start();
  const assets = o.assets ?? (await loadAssets());
  if (!assets.has("/index.html")) o.err("tcode: the web app isn't built into this binary (run: bun run build:web)\n");
  const token = randomBytes(32).toString("base64url");
  const server = await startWebServer({ host, assets, token, port: o.web.port ?? DEFAULT_PORT, dev: o.web.dev });
  o.out(`Tropos Code is running at:\n\n  ${server.url}\n\nThe link carries a secret key for this run; keep it to yourself. Press ctrl+c to stop.\n`);
  if (o.web.open) (o.openBrowser ?? openInBrowser)(server.url);
  try {
    await (o.until ? o.until(server) : untilSignal());
  } finally {
    await server.stop();
    await host.shutdown();
  }
  return 0;
}
