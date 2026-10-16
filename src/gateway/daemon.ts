// src/gateway/daemon.ts — `tcode gateway`: the session pool, the channel adapters and the local web UI, until stopped.
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Model } from "../api/model";
import { loadProjectContext, type ProjectContext } from "../cli/context";
import { createRuntime } from "../cli/runtime";
import { SettingsError } from "../config/settings";
import { VERSION } from "../version";
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
import { SandboxUnavailableError, UserFacingError } from "./errors";
import {
  DEFAULT_PROJECT_ID,
  TEMPORARY_PROJECT_ID,
  builtinProject,
  ensureDefaultProject,
  fileProjectSource,
  withTemporaryProject,
  type Project,
} from "./projects";
import { ChatRouter, RoutedSessions, parseSessionKey, sessionKey } from "./router";
import { reapRevoked } from "./revocation";
import { SessionPool, type HostHandle } from "./pool";
import { CHANNEL_MODES, channelContext, chatRole, workspaceProblem } from "./policy";
import { homedir } from "node:os";
import { createAdmin } from "../web/admin";
import { AdminError } from "../web/admin/context";
import { createCronTool } from "../tools/cron/cron-tool";
import { CronStore } from "./cron/store";
import { createCronGatewayService } from "./cron/service";
import { TelegramAdapter, type TelegramAdapterOptions } from "./telegram/adapter";
import { TelegramApi } from "./telegram/api";
import type { ChannelAdapter, ChatProjects, GatewayService, GatewayServiceDeps, Pairing, SessionRole } from "./types";

export type { SessionContext } from "../cli/context";

export interface GatewayRun {
  /** Tropos's data directory. */
  home: string;
  env: NodeJS.ProcessEnv;
  version?: string;
  /** Tests pass a fake model; otherwise each project's provider router answers. */
  model?: Model;
  config: GatewayConfig;
  pairing: Pairing;
  out(text: string): void;
  err(text: string): void;
  /** Serve the local web UI (default true). */
  web?: boolean;
  /** `--workspace <dir>`: a one-off project (id `cwd`) that is the default for this run only. Nothing is saved. */
  workspace?: string;
  /** Background services (a scheduler, say), started after the channels and stopped before them. */
  services?: GatewayService[];
  /** Print the web UI link with its key (default: only when stdout is a terminal). */
  showLink?: boolean;
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
    /** Replaces `git init` for the managed default project. */
    git?: (dir: string) => Promise<void>;
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

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export async function runGateway(run: GatewayRun): Promise<number> {
  const { home, config } = run;
  const version = run.version ?? VERSION;
  const dir = gatewayDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // The managed default project exists before anything asks for it: the sandbox relies on its .git.
  await ensureDefaultProject(home, { git: run.seams?.git });

  let oneOff: Project | undefined;
  if (run.workspace) {
    const path = real(run.workspace);
    const problem = workspaceProblem(path, home);
    if (problem) {
      run.err(`tcode: gateway: ${problem}\n`);
      return 1;
    }
    oneOff = { id: TEMPORARY_PROJECT_ID, name: basename(path) || "workspace", path };
    if (!existsSync(join(path, ".git"))) warnNoGit(run, path);
  }
  const source = withTemporaryProject(fileProjectSource(home), oneOff);
  const router = new ChatRouter({ home, source });

  // One context per project directory, built the first time something needs it: settings, skills, memory and MCP
  // servers are per project, and a broken settings file in one must not stop the others.
  const contexts = new Map<string, Promise<ProjectContext>>();
  const warned = new Set<string>();
  const contextFor = (project: Project): Promise<ProjectContext> => {
    let pending = contexts.get(project.path);
    if (!pending) {
      pending = loadProjectContext({ cwd: project.path, home, env: run.env, version, model: run.model }).then(
        (pc) => {
          for (const w of pc.warnings) run.err(`tcode: ${project.id}: ${w}\n`);
          if (!project.builtin && !warned.has(project.path) && !existsSync(join(pc.ctx.cwd, ".git"))) warnNoGit(run, pc.ctx.cwd);
          warned.add(project.path);
          return pc;
        },
        (e: unknown) => {
          // Not cached: once the file is fixed, the next message works without restarting the gateway.
          contexts.delete(project.path);
          if (e instanceof SettingsError) throw new UserFacingError(`The settings of project "${project.name}" are invalid, so I can't start a session there: ${e.message}`);
          throw e;
        },
      );
      contexts.set(project.path, pending);
    }
    return pending;
  };

  // The scheduler: jobs run in fresh sandboxed sessions of their project and are delivered through the channels.
  const cron = createCronGatewayService({ log: (m) => run.err(`gateway: cron: ${m}\n`) });
  const cronStore = new CronStore(home);

  const check = run.seams?.sandboxCheck ?? dockerCheck();
  if (run.seams?.sweep !== false && !run.seams?.backend) await sweepLeftoverContainers().catch(() => 0);

  // The role each open session was created with, so the reaper can close an owner session when ownership moves.
  const roles = new Map<string, SessionRole>();
  const pool = new SessionPool({
    statePath: join(dir, "sessions.json"),
    idleMs: config.idleMinutes * 60_000,
    create: async (key, saved): Promise<HostHandle> => {
      const projectId = parseSessionKey(key)?.projectId ?? DEFAULT_PROJECT_ID;
      const project = await source.get(projectId);
      if (!project) throw new UserFacingError("That project doesn't exist any more. Send /project to pick another.");
      if (project.builtin) await ensureDefaultProject(home, { git: run.seams?.git });
      else {
        const problem = workspaceProblem(project.path, home);
        if (problem) throw new UserFacingError(`Project "${project.name}" can't be used: ${problem}`);
      }
      // Fail closed: a chat's commands run in the sandbox or not at all.
      const sandboxProblem = await check();
      if (sandboxProblem) throw new SandboxUnavailableError(sandboxProblem);
      const pc = await contextFor(project);
      const cwd = pc.ctx.cwd;
      const backend =
        run.seams?.backend?.(cwd) ??
        new DockerBackend({ workspace: cwd, image: config.sandbox.image, network: config.sandbox.network, memory: config.sandbox.memory, cpus: config.sandbox.cpus });
      const { ctx: base, setSessionId } = await pc.newSessionContext();
      const role = await chatRole(parseSessionKey(key)?.chatKey ?? "", run.pairing);
      const sessionCtx = channelContext(base, backend, { role });
      roles.set(key, role);
      // A chat can ask the agent to schedule work ("every weekday at 9, summarise the open PRs"); it asks first, and the
      // result comes back to this chat. Scheduled runs themselves (project:* sessions) cannot schedule more.
      const chatKey = parseSessionKey(key)?.chatKey;
      if (chatKey && !chatKey.startsWith("project:")) {
        sessionCtx.tools = [...sessionCtx.tools, createCronTool({ store: cronStore, defaultDeliver: () => chatKey, runNow: (id) => cron.runNow(id) }) as (typeof sessionCtx.tools)[number]];
      }
      let session: SessionStore;
      let history: Awaited<ReturnType<typeof SessionStore.open>>["messages"] = [];
      let resumed = false;
      try {
        if (saved) {
          ({ store: session, messages: history } = await SessionStore.open(home, cwd, saved));
          resumed = true;
        } else {
          session = await SessionStore.create(home, { cwd, model: pc.ctx.settings.model, version });
        }
      } catch {
        // The remembered session is gone: start over rather than fail the chat.
        session = await SessionStore.create(home, { cwd, model: pc.ctx.settings.model, version });
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
          // Only the owner's chats learn; a guest's chat is not material for the owner's memory.
          learn: role === "owner",
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

  const sessions = new RoutedSessions(router, pool);
  const chatProjects: ChatProjects = { current: (k) => router.current(k), list: () => source.list(), select: (k, id) => router.select(k, id) };
  const adapters: ChannelAdapter[] = [];
  const token = telegramToken(config, run.env);
  if (token) {
    const api = run.seams?.telegramApi ?? new TelegramApi({ token });
    adapters.push(
      new TelegramAdapter({ api, sessions, projects: chatProjects, pairing: run.pairing, log: (m) => run.err(`gateway: telegram: ${m}\n`), ...run.seams?.telegramOptions }),
    );
  }

  let webStop: (() => Promise<void>) | undefined;
  let webHost: WebHost | undefined;
  let webUrl: string | undefined;
  let webPort: number | undefined;
  if (run.web !== false) {
    try {
      // The local web UI works in the default project.
      const project = (await source.get(await source.defaultId())) ?? builtinProject(home);
      const { ctx, newSessionContext } = await contextFor(project);
      const { ctx: localCtx, setSessionId } = await newSessionContext();
      const session = await SessionStore.create(home, { cwd: ctx.cwd, model: ctx.settings.model, version });
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
      const admin = createAdmin({
        home,
        userHome: homedir(),
        env: run.env,
        version,
        execPath: process.execPath,
        scriptPath: process.argv[1],
        cwd: ctx.cwd,
        now: Date.now,
        fetch,
        gateway: {
          // Starts the job and answers at once; a job that cannot start (already running, unknown) is reported.
          runCronNow: async (id) => {
            const started = cron.runNow(id);
            started.catch(() => {});
            await Promise.race([started.then(() => undefined), new Promise<void>((r) => setTimeout(r, 150))]).catch((e: unknown) => {
              throw new AdminError(e instanceof Error ? e.message : "The job could not be started.");
            });
          },
          reload: async () => {},
        },
      });
      const server = await startWebServer({ host: webHost, admin, assets, token: await persistentToken(dir), port: config.webPort ?? DEFAULT_PORT });
      webStop = () => server.stop();
      webUrl = server.url;
      webPort = server.port;
    } catch (e) {
      // Chats don't depend on the web UI, and a broken default project shouldn't take them down.
      if (!(e instanceof UserFacingError)) throw e;
      run.err(`tcode: gateway: the local web UI is off: ${e.message}\n`);
    }
  }

  const deliver = async (target: string, text: string): Promise<void> => {
    const adapter = adapters.find((a) => target.startsWith(`${a.name}:`));
    if (!adapter?.deliver) throw new Error(`No channel can deliver to "${target}".`);
    await adapter.deliver(target, text);
  };
  const serviceDeps: GatewayServiceDeps = {
    home,
    config,
    projects: source,
    deliver,
    openSession: async (target) => {
      if (target.includes(":")) return sessions.open(target);
      if (!(await source.get(target))) throw new UserFacingError(`There is no project "${target}".`);
      return pool.open(sessionKey(`project:${target}`, target));
    },
  };

  const state: GatewayState = { pid: process.pid, startedAt: new Date().toISOString(), webPort, telegram: adapters.length > 0 };
  await writeFile(stateFile(home), `${JSON.stringify(state)}\n`, { mode: 0o600 });

  const startedServices: GatewayService[] = [];
  let stopReaper = (): void => {};
  try {
    for (const adapter of adapters) await adapter.start();
    for (const service of [cron, ...(run.services ?? [])]) {
      try {
        await service.start(serviceDeps);
        startedServices.push(service);
      } catch (e) {
        run.err(`gateway: service ${service.name} failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    const projects = await source.list();
    run.out(
      [
        `Tropos gateway running${oneOff ? ` in ${oneOff.path}` : ""}`,
        adapters.length > 0 ? `  channels: ${adapters.map((a) => a.name).join(", ")}` : "  channels: none (set TROPOS_TELEGRAM_BOT_TOKEN or telegram.botToken in ~/.tropos/gateway.json)",
        `  projects: ${projects.map((p) => p.id).join(", ")} (default: ${await source.defaultId()})`,
        // The link carries the web UI's key. On a terminal it is printed for you; under launchd/systemd stdout goes to a
        // log file that gets copied into bug reports, so there it stays out (`tcode dashboard` opens the real link).
        webUrl ? `  web: ${(run.showLink ?? Boolean(process.stdout.isTTY)) ? webUrl : `${webUrl.split("?")[0]} (open it with: tcode dashboard)`}` : "  web: off",
        "Press ctrl+c to stop.\n",
      ].join("\n"),
    );
    // A revoked sender's open sessions and scheduled jobs stop within a few seconds.
    const reaper = setInterval(() => {
      reapRevoked({ sessionKeys: () => pool.keys(), closeSession: (k, opts) => pool.close(k, opts), isApproved: (c, s) => run.pairing.isApproved(c, s), isOwner: (c, s) => run.pairing.isOwner(c, s), roleOf: (k) => roles.get(k), cron: cronStore })
        .then((r) => {
          if (r.sessions.length || r.jobs.length) run.err(`gateway: revoked sender: closed ${r.sessions.length} session(s), disabled ${r.jobs.length} job(s)\n`);
        })
        .catch(() => {});
    }, 5000);
    reaper.unref();
    stopReaper = () => clearInterval(reaper);
    await (run.until ? run.until({ webUrl }) : untilSignal());
  } finally {
    stopReaper();
    await Promise.all(startedServices.map((s) => s.stop().catch(() => {})));
    await Promise.all(adapters.map((a) => a.stop().catch(() => {})));
    await pool.closeAll();
    await webStop?.().catch(() => {});
    // Like the chats: the gateway is stopping, so the dashboard's session skips its final review.
    await webHost?.shutdown({ finalReview: false }).catch(() => {});
    // Sessions are closed first; then what the projects' extensions hold open (MCP servers, language servers).
    await Promise.all([...contexts.values()].map((p) => p.then((pc) => pc.close()).catch(() => {})));
    await rm(stateFile(home), { force: true });
  }
  return 0;
}

/** A mount can't protect a path that doesn't exist: a command could `git init` there and plant a hook or config. */
function warnNoGit(run: GatewayRun, path: string): void {
  run.err(`tcode: gateway: ${path} is not a git repository. Run \`git init\` there first, or a chat's command could create a .git with hooks in it.\n`);
}
