// src/gateway/daemon.ts — `tcode gateway`: the session pool, the channel adapters and the local web UI, until stopped.
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Model } from "../api/model";
import { loadProjectContext, type ProjectContext } from "../cli/context";
import { createRuntime } from "../cli/runtime";
import type { Runtime } from "../ui/runtime";
import { defaultRunner } from "../doctor/runner";
import type { Runner } from "../doctor/types";
import { SettingsError, settingsPaths } from "../config/settings";
import { VERSION } from "../version";
import { sweepLeftoverContainers } from "../exec/docker";
import type { Confinement, ExecBackend } from "../exec/backend";
import { confinementAvailable } from "../exec/confined";
import { SessionStore } from "../session/store";
import { DARK } from "../ui/theme";
import { MODES, type Mode } from "../config/constants";
import { loadAssets, type AssetMap } from "../web/assets";
import { WebHost } from "../web/host";
import { ProjectHosts } from "../web/project-hosts";
import { DEFAULT_PORT } from "../web/protocol";
import { PortInUseError, portHolder, portInUseMessage } from "../web/port";
import { DeviceStore, devicesPath } from "../web/devices";
import { loginCodesFor } from "../web/login-codes";
import { localDashboardUrl } from "../web/links";
import { startWebServer, type RunningWebServer } from "../web/server";
import { untilSignal } from "../web/serve";
import { GatewayConfigError, loadGatewayConfig, telegramToken, gatewayDir, type GatewayConfig } from "./config";
import { effectiveAutonomy, ensureChatSettings, lowerAutonomy, pinnedTestCommands, sessionAutonomy } from "./autonomy";
import { chatBackend } from "./chat-exec";
import { ProjectContexts } from "./contexts";
import { SenderNotApprovedError, UserFacingError } from "./errors";
import {
  DEFAULT_PROJECT_ID,
  TEMPORARY_PROJECT_ID,
  ensureDefaultProject,
  fileProjectSource,
  withTemporaryProject,
  type Project,
} from "./projects";
import { ChatRouter, RoutedSessions, parseSessionKey, sessionKey } from "./router";
import { privateTelegramSender, reapRevoked } from "./revocation";
import { SessionPool, type HostHandle } from "./pool";
import { ownerCronTool } from "../tools/cron/owner-cron";
import { ownerChatKey } from "./pairing";
import { CHANNEL_MODES, channelContext, chatRole, gatewayHosted, workspaceProblem } from "./policy";
import { homedir } from "node:os";
import { createAdmin } from "../web/admin";
import { AdminError } from "../web/admin/context";
import { createCronTool } from "../tools/cron/cron-tool";
import { CronStore } from "./cron/store";
import { createCronGatewayService } from "./cron/service";
import { createCuratorService } from "./curator-service";
import { TelegramAdapter, type TelegramAdapterOptions } from "./telegram/adapter";
import { TelegramApi } from "./telegram/api";
import type { ChannelAdapter, ChatAutonomy, ChatProjects, GatewayService, GatewayServiceDeps, Pairing, SessionRole } from "./types";

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
  /** `tcode gateway --dev`: the dashboard also accepts the Vite dev server's origin. */
  dev?: boolean;
  /** `--workspace <dir>`: a one-off project (id `cwd`) that is the default for this run only. Nothing is saved. */
  workspace?: string;
  /** Background services (a scheduler, say), started after the channels and stopped before them. */
  services?: GatewayService[];
  /** Tests stop the gateway themselves instead of waiting for a signal; `reload` is what the dashboard calls after a save. */
  until?: (info: { webUrl?: string; reload(): Promise<void> }) => Promise<void>;
  /** Test seams. */
  seams?: {
    backend?: (workspace: string) => ExecBackend;
    /** Returns why Docker can't be used, or undefined when it can (asked only when chats run in Docker). */
    sandboxCheck?: () => Promise<string | undefined>;
    /** Which OS confinement runs here (default: probe this machine). */
    confinement?: () => Promise<Confinement | null>;
    /** The owner's home, whose secrets confinement hides (default: os.homedir()). */
    userHome?: string;
    telegramApi?: TelegramApi;
    /** Overrides for the Telegram adapter (pacing, timeouts). */
    telegramOptions?: Partial<TelegramAdapterOptions>;
    assets?: AssetMap;
    /** The dashboard's port (tests pass 0 so they never take the real one). */
    webPort?: number;
    /** Looks up who holds a taken port (default: the real lsof/ss). */
    runner?: Pick<Runner, "exec">;
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

export interface GatewayState {
  pid: number;
  startedAt: string;
  webPort?: number;
  /** Why the dashboard is off, when it could not start (a port in use, say). */
  webProblem?: string;
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
  const { home } = run;
  // The saved file, re-read when a session starts and on reload: a level or backend changed in the dashboard or the
  // terminal applies to the next session, and the autonomy of open ones (their policy reads this) at once.
  let live = run.config;
  const refreshConfig = async (): Promise<GatewayConfig> => {
    try {
      live = await loadGatewayConfig(home);
    } catch (e) {
      // A broken edit keeps the last good settings rather than stopping every chat.
      if (!(e instanceof GatewayConfigError)) throw e;
      run.err(`gateway: keeping the last good settings: ${e.message}\n`);
    }
    return live;
  };
  const version = run.version ?? VERSION;
  const dir = gatewayDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Before anyone can be approved: an approval must not turn this fresh install into an "existing" one (ask, docker).
  await ensureChatSettings(home);
  await refreshConfig();

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
  // servers are per project, and a broken settings file in one must not stop the others. A reload replaces them.
  const warned = new Set<string>();
  const contexts = new ProjectContexts((project) =>
    loadProjectContext({ cwd: project.path, home, env: run.env, version, model: run.model }).then(
      (pc) => {
        for (const w of pc.warnings) run.err(`tcode: ${project.id}: ${w}\n`);
        if (!project.builtin && !warned.has(project.path) && !existsSync(join(pc.ctx.cwd, ".git"))) warnNoGit(run, pc.ctx.cwd);
        warned.add(project.path);
        return pc;
      },
      (e: unknown) => {
        // Not cached: once the file is fixed, the next message works without restarting the gateway.
        // The chat never sees file paths or parse detail; the log does.
        if (e instanceof SettingsError) {
          const layer = Object.entries(settingsPaths(project.path, home)).find(([, p]) => p === e.path)?.[0] ?? "unknown";
          run.err(`tcode: ${project.id}: ${layer} settings ${e.path}: ${e.message}\n`);
          throw new UserFacingError(`I can't start a session in "${project.name}" because its settings have a problem. The owner can see what's wrong in the dashboard (Status → Logs) or with tcode logs gateway.`);
        }
        throw e;
      },
    ),
  );

  // The scheduler: jobs run in fresh sandboxed sessions of their project and are delivered through the channels.
  const cron = createCronGatewayService({ log: (m) => run.err(`gateway: cron: ${m}\n`) });
  const cronStore = new CronStore(home);

  // Docker's answer; asked only for sessions that run in Docker.
  const check = run.seams?.sandboxCheck ?? dockerCheck();
  const confinement = run.seams?.confinement ?? confinementAvailable;
  const userHome = run.seams?.userHome ?? homedir();
  // Guests' sessions use Docker whatever chat.backend says, so leftovers are swept either way; only a Docker-backed
  // gateway waits for it (it was always started this way).
  if (run.seams?.sweep !== false && !run.seams?.backend) {
    const sweeping = sweepLeftoverContainers().catch(() => 0);
    if (live.chat.backend === "docker") await sweeping;
  }

  // The role each open session was created with, so the reaper can close an owner session when ownership moves.
  const roles = new Map<string, SessionRole>();
  const pool = new SessionPool({
    statePath: join(dir, "sessions.json"),
    idleMs: live.idleMinutes * 60_000,
    create: async (key, saved): Promise<HostHandle> => {
      const config = await refreshConfig();
      // A closed chat reopens on its next message; a revoked sender's queued messages must not reopen it. The adapter
      // checks new messages, this checks every session, so the two can't disagree.
      const sender = privateTelegramSender(parseSessionKey(key)?.chatKey ?? "");
      if (sender !== undefined && !(await run.pairing.isApproved("telegram", sender))) throw new SenderNotApprovedError();
      const projectId = parseSessionKey(key)?.projectId ?? DEFAULT_PROJECT_ID;
      const project = await source.get(projectId);
      if (!project) throw new UserFacingError("That project doesn't exist any more. Send /project to pick another.");
      if (project.builtin) await ensureDefaultProject(home, { git: run.seams?.git });
      else {
        const problem = workspaceProblem(project.path, home);
        if (problem) throw new UserFacingError(`Project "${project.name}" can't be used: ${problem}`);
      }
      // Held until the session closes: a reload meanwhile doesn't close its MCP servers under a running turn.
      const { pc, release } = await contexts.acquire(project);
      let exec: { backend: ExecBackend; confined: boolean } | undefined;
      try {
        const role = await chatRole(parseSessionKey(key)?.chatKey ?? "", run.pairing);
        // Fail closed: no Docker for a session that needs it, or no confinement it may go without, means no session.
        exec = await chatBackend({
          config,
          role,
          workspace: pc.ctx.cwd,
          home,
          userHome,
          env: run.env,
          confinement,
          dockerCheck: check,
          override: run.seams?.backend,
        });
        const handle = await startSession(key, saved, pc, role, exec);
        return {
          ...handle,
          close: async () => {
            try {
              await handle.close();
            } finally {
              release();
            }
          },
        };
      } catch (e) {
        await exec?.backend.close().catch(() => {});
        release();
        throw e;
      }
    },
  });

  /**
   * A chat's session on its project's context: its backend, its role's tools, its autonomy, and its transcript
   * (resumed when saved).
   */
  const startSession = async (
    key: string,
    saved: string | undefined,
    pc: ProjectContext,
    role: SessionRole,
    exec: { backend: ExecBackend; confined: boolean },
  ): Promise<HostHandle> => {
    const cwd = pc.ctx.cwd;
    const { backend, confined } = exec;
    const projectId = parseSessionKey(key)?.projectId ?? DEFAULT_PROJECT_ID;
    const { ctx: base, setSessionId } = await pc.newSessionContext();
    // Read on every permission decision, from the live config; guests stay at ask (sessionAutonomy).
    const sessionCtx = channelContext(base, backend, {
      role,
      autonomy: () => ({ level: sessionAutonomy({ config: live, projectId, role, confined }), testCommands: pinnedTestCommands(live, projectId) }),
    });
    roles.set(key, role);
    // A chat can ask the agent to schedule work ("every weekday at 9, summarise the open PRs"); it asks first, and the
    // result comes back to this chat. Scheduled runs themselves (project:* sessions) cannot schedule more.
    const chatKey = parseSessionKey(key)?.chatKey;
    if (chatKey && !chatKey.startsWith("project:")) {
      // The owner's chats see every job; a guest's chat only its own.
      sessionCtx.tools = [...sessionCtx.tools, createCronTool({ store: cronStore, seeAll: role === "owner", defaultDeliver: () => chatKey, origin: chatKey, runNow: (id) => cron.runNow(id) }) as (typeof sessionCtx.tools)[number]];
    }
    let session: SessionStore;
    let history: Awaited<ReturnType<typeof SessionStore.open>>["messages"] = [];
    let resumed = false;
    try {
      if (saved) {
        let meta: { role?: SessionRole };
        ({ store: session, messages: history, meta } = await SessionStore.open(home, cwd, saved));
        // The transcript says who it answers to now, so search can leave out a guest's words (older ones have no role).
        if (meta.role !== role) await session.recordRole(role);
        resumed = true;
      } else {
        session = await SessionStore.create(home, { cwd, model: pc.ctx.settings.model, version, role });
      }
    } catch {
      // The remembered session is gone: start over rather than fail the chat.
      session = await SessionStore.create(home, { cwd, model: pc.ctx.settings.model, version, role });
    }
    setSessionId(session.id);
    // On a failure here the caller closes the backend.
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
  };

  const sessions = new RoutedSessions(router, pool);
  const chatProjects: ChatProjects = { current: (k) => router.current(k), list: () => source.list(), select: (k, id) => router.select(k, id) };
  const chatAutonomy: ChatAutonomy = {
    current: async (k) => {
      const project = await router.current(k);
      return { level: effectiveAutonomy(await refreshConfig(), project.id), project: { id: project.id, name: project.name } };
    },
    lower: async (k, to) => {
      const project = await router.current(k);
      const out = await lowerAutonomy(home, project.id, to);
      // Open sessions read the live config at each decision: re-read it now, not at the next reload.
      await refreshConfig();
      return { ...out, project: { id: project.id, name: project.name } };
    },
  };
  // /login: a six-digit code from the same file-backed store the dashboard redeems against. Read lazily: the web server
  // (and so its port) starts after the channels.
  const loginMessage = async (): Promise<string> => {
    if (webPort === undefined) return "The dashboard isn't running, so there is nothing to log in to. Start it with: tcode gateway";
    const code = await loginCodesFor(home).issueCode();
    return `Login code: ${code.slice(0, 3)} ${code.slice(3)} (works once, for 10 minutes).\nOn the Mac: ${localDashboardUrl(webPort)}`;
  };
  const buildAdapters = (token: string | undefined): ChannelAdapter[] => {
    if (!token) return [];
    const api = run.seams?.telegramApi ?? new TelegramApi({ token });
    return [new TelegramAdapter({ api, sessions, projects: chatProjects, autonomy: chatAutonomy, loginMessage, pairing: run.pairing, log: (m) => run.err(`gateway: telegram: ${m}\n`), ...run.seams?.telegramOptions })];
  };
  let adapterToken = telegramToken(live, run.env);
  let adapters = buildAdapters(adapterToken);

  // What the dashboard calls after it saved a change: the project contexts and the sessions on them are rebuilt from
  // what is on disk now, and the channels when their token changed. One reload at a time, none once stopping.
  let state: GatewayState | undefined;
  let stopping = false;
  // The dashboard's chat: one host per project a tab opened. A reload moves each onto its project's fresh context.
  // `builtAt` is the reload count its context comes from, so a host that was opening during a reload is rebuilt too.
  const dashboardHosts = new Map<WebHost, { cwd: string; builtAt: number; swaps: Promise<void>; rebuild(): Promise<void> }>();
  let reloads = 0;
  let reloading: Promise<void> = Promise.resolve();
  const reloadOnce = async (): Promise<void> => {
    if (stopping) return;
    const config = await refreshConfig();
    // Only a new token restarts the channels: a restart cuts off running turns (their answers, approvals and queues).
    const token = telegramToken(config, run.env);
    if (token !== adapterToken) {
      await Promise.all(adapters.map((a) => a.stop().catch(() => {})));
      adapterToken = token;
      adapters = buildAdapters(token);
      for (const adapter of adapters) {
        await adapter.start().catch((e: unknown) => run.err(`gateway: ${adapter.name} failed to start: ${e instanceof Error ? e.message : String(e)}\n`));
      }
    }
    // A running turn keeps its context (and its MCP servers) until its session closes after the turn.
    contexts.invalidate();
    reloads++;
    await pool.retire();
    // A project removed (or moved under the same id) loses its dashboard chat, whose tabs go to the default project;
    // the default is read again for new tabs.
    await chatHosts?.refresh().catch((e: unknown) => run.err(`gateway: the dashboard's chat keeps its old projects: ${e instanceof Error ? e.message : String(e)}\n`));
    // An idle dashboard chat is rebuilt before the reload returns; a busy one after its turn, without holding the save.
    await Promise.all(
      [...dashboardHosts].map(([host, d]) => {
        if (host.isShutDown()) return void dashboardHosts.delete(host);
        // Opened during this reload, on the fresh context already.
        if (d.builtAt === reloads) return undefined;
        d.builtAt = reloads;
        const idle = !host.state().busy;
        const rebuilt = d.rebuild();
        return idle ? rebuilt : undefined;
      }),
    );
    if (state) {
      state = { ...state, telegram: adapters.length > 0 };
      await writeFile(stateFile(home), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    }
  };
  const reload = (): Promise<void> => (reloading = reloading.catch(() => {}).then(reloadOnce));

  let webServer: RunningWebServer | undefined;
  let chatHosts: ProjectHosts | undefined;
  let webUrl: string | undefined;
  let webPort: number | undefined;
  let webProblem: string | undefined;
  if (run.web !== false) {
    try {
      /**
       * A dashboard chat's runtime on its project's current context; `resume` continues that session after a reload.
       * The dashboard is the owner's (spec §5.3): the owner's rules and modes, commands on the host like the terminal.
       */
      const dashboardRuntime = async (project: Project, resume?: { sessionId: string; mode: Mode }): Promise<Runtime> => {
        const { pc, release } = await contexts.acquire(project);
        try {
          const { ctx: sessionCtx, setSessionId } = await pc.newSessionContext();
          const localCtx = gatewayHosted(sessionCtx);
          const opened = resume ? await SessionStore.open(home, localCtx.cwd, resume.sessionId) : undefined;
          const session = opened?.store ?? (await SessionStore.create(home, { cwd: localCtx.cwd, model: localCtx.settings.model, version, role: localCtx.role }));
          setSessionId(session.id);
          // The dashboard is the owner's: its Cron tool sees every job and delivers to the owner's chat.
          localCtx.tools = [...localCtx.tools, await ownerCronTool(home, { runNow: (id) => cron.runNow(id) })];
          const runtime = await createRuntime(localCtx, {
            session,
            history: opened?.messages ?? [],
            mode: resume?.mode ?? "default",
            modes: MODES.filter((m) => m !== "bypass"),
            theme: DARK,
            source: resume ? "resume" : "startup",
            ownsExtensions: false,
          });
          // The context is held for as long as this runtime lives: a reload's swap and the host's shutdown both end it.
          const shutdown = runtime.shutdown;
          runtime.shutdown = async (opts) => {
            try {
              await shutdown(opts);
            } finally {
              release();
            }
          };
          return runtime;
        } catch (e) {
          release();
          throw e;
        }
      };
      const openDashboard = async (projectId: string): Promise<WebHost> => {
        const project = await source.get(projectId);
        if (!project) throw new UserFacingError(`There is no project "${projectId}".`);
        if (project.builtin) await ensureDefaultProject(home, { git: run.seams?.git });
        const generation = reloads;
        const runtime = await dashboardRuntime(project);
        const host = new WebHost(runtime);
        await host.start();
        // A reload moves this chat onto the project's fresh context (settings, rules, MCP servers), resuming its
        // session; a running turn finishes first.
        const entry = {
          cwd: runtime.cwd,
          builtAt: generation,
          swaps: Promise.resolve(),
          rebuild: (): Promise<void> =>
            (entry.swaps = entry.swaps
              .then(() =>
                host.replaceRuntime(async (old) => {
                  if (stopping) return undefined;
                  const next = await dashboardRuntime(project, { sessionId: old.sessionId(), mode: old.state().mode });
                  // The old session ends without a final review: the conversation goes on in the new one.
                  await old.shutdown({ finalReview: false }).catch(() => {});
                  return next;
                }),
              )
              .catch((e: unknown) => run.err(`gateway: the dashboard's chat in ${project.id} keeps its old settings: ${e instanceof Error ? e.message : String(e)}\n`))),
        };
        dashboardHosts.set(host, entry);
        // A reload that ran while this opened may have left it on the old context.
        if (entry.builtAt !== reloads) {
          entry.builtAt = reloads;
          void entry.rebuild();
        }
        return host;
      };
      // New tabs start in the default project (read again at each reload); a tab moves with project.select.
      chatHosts = await ProjectHosts.create({ get: (id) => source.get(id), defaultId: () => source.defaultId(), open: openDashboard });
      // The one host create opened: the default project's.
      const cwd = [...dashboardHosts.values()][0]!.cwd;
      const assets = run.seams?.assets ?? (await loadAssets());
      const admin = createAdmin({
        home,
        userHome: homedir(),
        env: run.env,
        version,
        execPath: process.execPath,
        scriptPath: process.argv[1],
        cwd,
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
          reload,
          devicesChanged: async () => {
            await webServer?.recheckDevices();
          },
        },
      });
      // Browsers log in on the socket: device keys (hashed on disk) and the codes `tcode dashboard` issues.
      const devices = new DeviceStore({ path: devicesPath(home) });
      const server = await startWebServer({ host: chatHosts, admin, assets, devices, logins: loginCodesFor(home), port: run.seams?.webPort ?? live.webPort ?? DEFAULT_PORT, dev: run.dev });
      webServer = server;
      webUrl = server.url;
      webPort = server.port;
    } catch (e) {
      // Chats don't depend on the web UI, and a broken default project shouldn't take them down.
      if (e instanceof PortInUseError) {
        const message = portInUseMessage(e.port, await portHolder(e.port, run.seams?.runner ?? defaultRunner()), (await readGatewayState(home))?.pid);
        webProblem = message;
        run.err(`tcode: gateway: the dashboard is off: ${message}\n`);
      } else if (e instanceof UserFacingError) {
        run.err(`tcode: gateway: the local web UI is off: ${e.message}\n`);
      } else throw e;
    }
  }

  const deliver = async (target: string, text: string): Promise<void> => {
    const adapter = adapters.find((a) => target.startsWith(`${a.name}:`));
    if (!adapter?.deliver) throw new Error(`No channel can deliver to "${target}".`);
    await adapter.deliver(target, text);
  };
  const serviceDeps: GatewayServiceDeps = {
    home,
    config: live,
    projects: source,
    deliver,
    openSession: async (target, opts) => {
      if (target.includes(":")) return sessions.open(target);
      if (!(await source.get(target))) throw new UserFacingError(`There is no project "${target}".`);
      // A guest's job gets a session of its own that runs (and is recorded) as a guest's.
      return pool.open(sessionKey(`project:${target}${opts?.untrusted ? ":guest" : ""}`, target));
    },
    ownerChat: () => ownerChatKey(run.pairing),
  };

  state = { pid: process.pid, startedAt: new Date().toISOString(), webPort, ...(webProblem ? { webProblem } : {}), telegram: adapters.length > 0 };
  await writeFile(stateFile(home), `${JSON.stringify(state)}\n`, { mode: 0o600 });

  const startedServices: GatewayService[] = [];
  let stopReaper = (): void => {};
  try {
    for (const adapter of adapters) await adapter.start();
    for (const service of [cron, createCuratorService({ log: (m) => run.err(`gateway: curator: ${m}\n`) }), ...(run.services ?? [])]) {
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
        adapters.length > 0 ? `  channels: ${adapters.map((a) => a.name).join(", ")}` : "  channels: none (connect Telegram in the dashboard: tcode dashboard, or ask me in the terminal)",
        `  projects: ${projects.map((p) => p.id).join(", ")} (default: ${await source.defaultId()})`,
        // No key in the address any more: a browser logs in on the page (`tcode dashboard` opens it logged in).
        webUrl ? `  web: ${webUrl} (open it with: tcode dashboard)` : "  web: off",
        "Press ctrl+c to stop.\n",
      ].join("\n"),
    );
    // A revoked sender's open sessions and scheduled jobs stop within a few seconds.
    const reaper = setInterval(() => {
      reapRevoked({ sessionKeys: () => pool.keys(), closeSession: (k, opts) => pool.close(k, opts), isApproved: (c, s) => run.pairing.isApproved(c, s), isOwner: (c, s) => run.pairing.isOwner(c, s), roleOf: (k) => roles.get(k), cron: cronStore, log: (m) => run.err(`gateway: revocation: ${m}\n`) })
        .then((r) => {
          if (r.sessions.length || r.jobs.length) run.err(`gateway: revoked sender: closed ${r.sessions.length} session(s), disabled ${r.jobs.length} job(s)\n`);
        })
        .catch(() => {});
      // A device revoked by another process (or expired) loses its open tabs too.
      webServer?.recheckDevices().catch(() => {});
    }, 5000);
    reaper.unref();
    stopReaper = () => clearInterval(reaper);
    await (run.until ? run.until({ webUrl, reload }) : untilSignal());
  } finally {
    stopping = true;
    stopReaper();
    await reloading.catch(() => {});
    await Promise.all(startedServices.map((s) => s.stop().catch(() => {})));
    await Promise.all(adapters.map((a) => a.stop().catch(() => {})));
    await pool.closeAll();
    await webServer?.stop().catch(() => {});
    // Like the chats: the gateway is stopping, so the dashboard's sessions skip their final review.
    await chatHosts?.shutdown({ finalReview: false }).catch(() => {});
    // A rebuild a reload started: the stopped host shuts down whatever it built.
    await Promise.all([...dashboardHosts.values()].map((d) => d.swaps));
    // Sessions are closed first; then what the projects' extensions hold open (MCP servers, language servers).
    await contexts.closeAll();
    await rm(stateFile(home), { force: true });
  }
  return 0;
}

/** A mount can't protect a path that doesn't exist: a command could `git init` there and plant a hook or config. */
function warnNoGit(run: GatewayRun, path: string): void {
  run.err(`tcode: gateway: ${path} is not a git repository. Run \`git init\` there first, or a chat's command could create a .git with hooks in it.\n`);
}
