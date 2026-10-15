// src/gateway/daemon.ts — `tcode gateway`: the session pool, the channel adapters and the local web UI, until stopped.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext } from "../cli/runtime";
import { createRuntime } from "../cli/runtime";
import { DockerBackend, sweepLeftoverContainers } from "../exec/docker";
import type { ExecBackend } from "../exec/backend";
import { SessionStore } from "../session/store";
import { DARK } from "../ui/theme";
import { MODES } from "../config/constants";
import { loadAssets, type AssetMap } from "../web/assets";
import { WebHost } from "../web/host";
import { DEFAULT_PORT } from "../web/protocol";
import { startWebServer } from "../web/server";
import { untilSignal } from "../web/serve";
import { telegramToken, gatewayDir, type GatewayConfig } from "./config";
import { SandboxUnavailableError } from "./errors";
import { SessionPool, type HostHandle } from "./pool";
import { CHANNEL_MODES, channelContext, workspaceProblem } from "./policy";
import { TelegramAdapter, type TelegramAdapterOptions } from "./telegram/adapter";
import { TelegramApi } from "./telegram/api";
import type { ChannelAdapter, Pairing } from "./types";

export interface SessionContext {
  ctx: AppContext;
  /** Tells the SessionSearch tool which session is current, so it skips it. */
  setSessionId(id: string): void;
}

export interface GatewayRun {
  /** The gateway's workspace context: settings, rules, extensions. Chats get narrowed copies. */
  ctx: AppContext;
  /** A fresh context for one session: its own subagent holder and tools over the shared extensions. */
  newSessionContext(): SessionContext;
  config: GatewayConfig;
  pairing: Pairing;
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  /** Serve the local web UI (default true). */
  web?: boolean;
  /** Tests stop the gateway themselves instead of waiting for a signal. */
  until?: (info: { webUrl?: string }) => Promise<void>;
  /** Test seams. */
  seams?: {
    backend?: (workspace: string) => ExecBackend;
    /** Returns why the sandbox can't be used, or undefined when it can. */
    sandboxCheck?: () => Promise<string | undefined>;
    telegramApi?: TelegramApi;
    /** Overrides for the Telegram adapter (pacing, timeouts). */
    telegramOptions?: Partial<TelegramAdapterOptions>;
    assets?: AssetMap;
    sweep?: boolean;
  };
}

/** Asks Docker whether it is up. The answer is cached for a few seconds: every new chat session asks. */
export function dockerCheck(bin = "docker", now: () => number = Date.now): () => Promise<string | undefined> {
  let cached: { at: number; result: string | undefined } | undefined;
  return async () => {
    if (cached && now() - cached.at < 15_000) return cached.result;
    let result: string | undefined;
    try {
      const proc = Bun.spawn([bin, "info", "--format", "{{.ServerVersion}}"], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), 8_000);
      const code = await proc.exited;
      clearTimeout(timer);
      result = code === 0 ? undefined : "Docker is installed but not running";
    } catch {
      result = "Docker isn't installed";
    }
    cached = { at: now(), result };
    return result;
  };
}

/** The web UI's link stays the same across restarts: the token is created once and kept (0600). */
export async function persistentToken(dir: string): Promise<string> {
  const path = join(dir, "token");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // none yet
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${token}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return token;
}

export interface GatewayState {
  pid: number;
  startedAt: string;
  webPort?: number;
  telegram: boolean;
}

export const stateFile = (home: string) => join(gatewayDir(home), "state.json");

export async function readGatewayState(home: string): Promise<GatewayState | undefined> {
  try {
    return JSON.parse(await readFile(stateFile(home), "utf8")) as GatewayState;
  } catch {
    return undefined;
  }
}

export async function runGateway(run: GatewayRun): Promise<number> {
  const { ctx, config } = run;
  const problem = workspaceProblem(ctx.cwd, ctx.home);
  if (problem) {
    run.err(`tcode: gateway: ${problem}\n`);
    return 1;
  }
  const dir = gatewayDir(ctx.home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(ctx.cwd, ".git"))) {
    // A mount can't protect a path that doesn't exist: a command could `git init` here and plant a hook or config
    // that runs the next time you use git in this directory.
    run.err(`tcode: gateway: ${ctx.cwd} is not a git repository. Run \`git init\` there first, or a chat's command could create a .git with hooks in it.\n`);
  }
  const check = run.seams?.sandboxCheck ?? dockerCheck();
  if (run.seams?.sweep !== false && !run.seams?.backend) await sweepLeftoverContainers().catch(() => 0);

  const pool = new SessionPool({
    statePath: join(dir, "sessions.json"),
    idleMs: config.idleMinutes * 60_000,
    create: async (key, saved): Promise<HostHandle> => {
      // Fail closed: a chat's commands run in the sandbox or not at all.
      const sandboxProblem = await check();
      if (sandboxProblem) throw new SandboxUnavailableError(sandboxProblem);
      const backend =
        run.seams?.backend?.(ctx.cwd) ??
        new DockerBackend({ workspace: ctx.cwd, image: config.sandbox.image, network: config.sandbox.network, memory: config.sandbox.memory, cpus: config.sandbox.cpus });
      const { ctx: base, setSessionId } = run.newSessionContext();
      const sessionCtx = channelContext(base, backend);
      let session: SessionStore;
      let history: Awaited<ReturnType<typeof SessionStore.open>>["messages"] = [];
      let resumed = false;
      try {
        if (saved) {
          ({ store: session, messages: history } = await SessionStore.open(ctx.home, ctx.cwd, saved));
          resumed = true;
        } else {
          session = await SessionStore.create(ctx.home, { cwd: ctx.cwd, model: ctx.settings.model, version: ctx.version });
        }
      } catch {
        // The remembered session is gone: start over rather than fail the chat.
        session = await SessionStore.create(ctx.home, { cwd: ctx.cwd, model: ctx.settings.model, version: ctx.version });
      }
      setSessionId(session.id);
      try {
        const runtime = await createRuntime(sessionCtx, {
          session,
          history,
          mode: "default",
          modes: CHANNEL_MODES,
          theme: DARK,
          source: resumed ? "resume" : "startup",
          interactive: false,
          ownsExtensions: false,
        });
        const host = new WebHost(runtime);
        await host.start();
        return {
          host,
          sessionId: () => runtime.sessionId(),
          close: () => backend.close(),
        };
      } catch (e) {
        await backend.close().catch(() => {});
        throw e;
      }
    },
  });

  const adapters: ChannelAdapter[] = [];
  const token = telegramToken(config, run.env);
  if (token) {
    const api = run.seams?.telegramApi ?? new TelegramApi({ token });
    adapters.push(new TelegramAdapter({ api, sessions: pool, pairing: run.pairing, log: (m) => run.err(`gateway: telegram: ${m}\n`), ...run.seams?.telegramOptions }));
  }

  let webStop: (() => Promise<void>) | undefined;
  let webHost: WebHost | undefined;
  let webUrl: string | undefined;
  let webPort: number | undefined;
  if (run.web !== false) {
    const { ctx: localCtx, setSessionId } = run.newSessionContext();
    const session = await SessionStore.create(ctx.home, { cwd: ctx.cwd, model: ctx.settings.model, version: ctx.version });
    setSessionId(session.id);
    const runtime = await createRuntime(localCtx, {
      session,
      history: [],
      mode: "default",
      modes: MODES.filter((m) => m !== "bypass"),
      theme: DARK,
      ownsExtensions: false,
    });
    webHost = new WebHost(runtime);
    await webHost.start();
    const assets = run.seams?.assets ?? (await loadAssets());
    const server = await startWebServer({ host: webHost, assets, token: await persistentToken(dir), port: config.webPort ?? DEFAULT_PORT });
    webStop = () => server.stop();
    webUrl = server.url;
    webPort = server.port;
  }

  const state: GatewayState = { pid: process.pid, startedAt: new Date().toISOString(), webPort, telegram: adapters.length > 0 };
  await writeFile(stateFile(ctx.home), `${JSON.stringify(state)}\n`, { mode: 0o600 });

  try {
    for (const adapter of adapters) await adapter.start();
    run.out(
      [
        `Tropos gateway running in ${ctx.cwd}`,
        adapters.length > 0 ? `  channels: ${adapters.map((a) => a.name).join(", ")}` : "  channels: none (set TROPOS_TELEGRAM_BOT_TOKEN or telegram.botToken in ~/.tropos/gateway.json)",
        webUrl ? `  web: ${webUrl}` : "  web: off",
        "Press ctrl+c to stop.\n",
      ].join("\n"),
    );
    await (run.until ? run.until({ webUrl }) : untilSignal());
  } finally {
    await Promise.all(adapters.map((a) => a.stop().catch(() => {})));
    await pool.closeAll();
    await webStop?.().catch(() => {});
    await webHost?.shutdown().catch(() => {});
    await rm(stateFile(ctx.home), { force: true });
  }
  return 0;
}
