import { render } from "ink";
import { ownerCronTool } from "../tools/cron/owner-cron";
import { suggestionTool, withSuggestions } from "../suggest/wire";
import type { Model } from "../api/model";
import { ProviderRouter } from "../providers/router";
import { MODES, type Mode } from "../config/constants";
import { SettingsError, loadSettings, settingsPaths, type Settings } from "../config/settings";
import { compileRules } from "../permissions/engine";
import { troposHome } from "../paths";
import { ModelPrefs } from "../config/model-prefs";
import { SessionStore, listSessions, type MessageParam } from "../session/store";
import { resolveToolPath } from "../tools/paths";
import { createTools } from "../tools/registry";
import { homedir } from "node:os";
import { SecretVault } from "../tools/setup/secrets";
import { createSetupTool } from "../tools/setup/setup-tool";
import { sessionAdmin } from "../tools/setup/session-admin";
import { requestGatewayReload } from "../gateway/reload-signal";
import { App } from "../ui/App";
import { resolveTheme } from "../ui/theme";
import { autoRegisterProject } from "../gateway/projects";
import { layoutAtStart } from "../home/migrate";
import { VERSION } from "../version";
import { startNativeSession } from "../install/session";
import { runInstallCommand, type CommandContext } from "../install/commands";
import { productionAfterUpdate } from "./after-update";
import type { Channel } from "../install/channels";
import { CliError, parseInvocation, type CliOptions } from "./args";
import { PRINT_DENY, PrintRenderer, runPrint } from "./print";
import { parseCommand } from "../ui/commands";
import { sanitizeForTerminal } from "../ui/terminal-safe";
import { harnessNonce } from "../context/tags";
import { extraCommands, loadExtensions, sessionTools, type SubagentHolder } from "./extensions";
import {
  commandIO,
  createRuntime,
  createToolContext,
  expandSlash,
  makeAgent,
  sessionEnd,
  sessionHooks,
  sessionStart,
  type AppContext,
} from "./runtime";
import { closeRuntime } from "./shutdown";
import { USAGE } from "./usage";
import { runGatewayCommand } from "../gateway/commands";
import { harnessWarnings, loadHarness } from "../harness/tree";
import { createLifecycleContext } from "./lifecycle/context";
import { loadLifecycle } from "./lifecycle";
import type { LifecycleContext } from "./lifecycle/types";
import { GatewayConfigError, configPermissionWarning, gatewayDir, loadGatewayConfig } from "../gateway/config";
import { runGateway, type GatewayRun } from "../gateway/daemon";
import { FilePairing } from "../gateway/pairing";
import { join } from "node:path";

/** sysexits.h EX_USAGE; distinct from the print-mode exit codes in EXIT_CODES. */
export const EXIT_USAGE = 64;

export interface MainDeps {
  model?: Model;
  out?: (s: string) => void;
  err?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  readStdin?: () => Promise<string | null>;
  /** The running executable; tests point it inside a fixture's versions/ to act as a native install. */
  execPath?: string;
  engine?: CommandContext["engine"];
  /** What an update does next (restart the service); tests that fake the engine get nothing real by default. */
  afterUpdate?: CommandContext["afterUpdate"];
  /** Tests override terminal detection for the native-session announcement. */
  tty?: { stdin: boolean; stdout: boolean };
  /** Tests replace parts of the lifecycle commands' context (prompts, terminal detection, clock). */
  lifecycle?: Partial<LifecycleContext>;
  /** Tests stop `tcode gateway` themselves and fake what it talks to. */
  gatewayUntil?: GatewayRun["until"];
  gatewaySeams?: GatewayRun["seams"];
  /** Background services for `tcode gateway` (the scheduler is one); tests pass fakes. */
  gatewayServices?: GatewayRun["services"];
}

export { pickShell } from "./context";
import { pickShell } from "./context";

async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const text = await Bun.stdin.text();
  return text.trim() ? text : null;
}

/** Runs the CLI. Any failure that isn't handled below becomes one `tcode: <message>` line and exit code 1. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (e) {
    const err = deps.err ?? ((s: string) => void process.stderr.write(s));
    err(`tcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

async function run(argv: string[], deps: MainDeps): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));

  let opts: CliOptions;
  try {
    const invocation = parseInvocation(argv);
    if (invocation.kind === "subcommand") {
      const env = deps.env ?? process.env;
      const cwd = resolveToolPath(".", deps.cwd ?? process.cwd());
      const cmd = invocation.command;
      let settings: { autoUpdates: boolean; autoUpdatesChannel: Channel } = { autoUpdates: true, autoUpdatesChannel: "latest" };
      // Only install and update read settings; help, install --self and rollback must work with a corrupt file.
      if (cmd.kind === "install" || cmd.kind === "update") {
        try {
          const loaded = (await loadSettings(settingsPaths(cwd, troposHome(env)))).settings;
          settings = { autoUpdates: loaded.autoUpdates, autoUpdatesChannel: loaded.autoUpdatesChannel };
        } catch (e) {
          // A background update never fails loudly: it falls back to defaults.
          if (!(e instanceof SettingsError)) throw e;
          if (!(cmd.kind === "update" && cmd.background)) {
            err(`tcode: ${e.message}\n`);
            return 1;
          }
        }
      }
      return await runInstallCommand(invocation.command, {
        out,
        err,
        env,
        execPath: deps.execPath ?? process.execPath,
        version: VERSION,
        settings,
        engine: deps.engine,
        afterUpdate: deps.afterUpdate ?? (deps.engine ? undefined : productionAfterUpdate(env)),
      });
    }
    if (invocation.kind === "lifecycle") {
      if (invocation.notice) err(`${invocation.notice}\n`);
      const run = await loadLifecycle(invocation.name);
      const lifecycleDeps = { out, err, env: deps.env ?? process.env, cwd: deps.cwd ?? process.cwd(), execPath: deps.execPath ?? process.execPath, scriptPath: process.argv[1] };
      return await run(invocation.argv, createLifecycleContext(lifecycleDeps, deps.lifecycle));
    }
    if (invocation.kind === "gateway-command") {
      return await runGatewayCommand(invocation.command, {
        out,
        err,
        env: deps.env ?? process.env,
        cwd: deps.cwd ?? process.cwd(),
        execPath: deps.execPath ?? process.execPath,
        scriptPath: process.argv[1],
      });
    }
    opts = invocation.options;
  } catch (e) {
    if (e instanceof CliError) {
      err(`tcode: ${e.message}\nRun tcode --help for usage.\n`);
      return EXIT_USAGE;
    }
    throw e;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.version) {
    out(`${VERSION} (Tropos Code)\n`);
    return 0;
  }

  const env = deps.env ?? process.env;
  /** Native-install bookkeeping shared by sessions and the gateway: the in-use lock, re-exec and the update notice. */
  async function enterNativeSession(autoUpdates: boolean, print: boolean): Promise<number | undefined> {
    const native = await startNativeSession({
      env,
      execPath: deps.execPath ?? process.execPath,
      print,
      stdinTTY: deps.tty?.stdin ?? (Boolean(process.stdin.isTTY) && !deps.readStdin),
      stdoutTTY: deps.tty?.stdout ?? Boolean(process.stdout.isTTY),
      autoUpdates,
      version: VERSION,
    });
    if (native.kind === "reexec") {
      // Starting must never fail loudly because of re-exec: if the target cannot run, carry on in this process.
      try {
        const proc = Bun.spawn([native.via, ...argv], { stdio: ["inherit", "inherit", "inherit"], env: { ...env, TROPOS_REEXEC: "1" } });
        return await proc.exited;
      } catch {
        // fall through to a native session without the in-use lock
      }
    }
    if (native.kind === "native" && native.announcement) err(`${native.announcement}\n`);
    return undefined;
  }

  /** `tcode gateway`: no workspace to name; the projects come from ~/.tropos/gateway.json (and `--workspace` for one run). */
  async function runGatewayMode(gateway: NonNullable<CliOptions["gateway"]>): Promise<number> {
    const entered = await enterNativeSession(true, false);
    if (entered !== undefined) return entered;
    const home = troposHome(env);
    let config;
    try {
      config = await loadGatewayConfig(home);
    } catch (e) {
      if (e instanceof GatewayConfigError) {
        err(`tcode: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
    const warning = await configPermissionWarning(home);
    if (warning) err(`tcode: ${warning}\n`);
    await layoutAtStart(home, VERSION, err);
    return await runGateway({
      home,
      env,
      version: VERSION,
      model: deps.model,
      config,
      pairing: new FilePairing({ path: join(gatewayDir(home), "pairing.json") }),
      out,
      err,
      web: gateway.web,
      dev: gateway.dev,
      workspace: gateway.workspace ? resolveToolPath(gateway.workspace, deps.cwd ?? process.cwd()) : undefined,
      services: deps.gatewayServices,
      until: deps.gatewayUntil,
      seams: deps.gatewaySeams,
    });
  }

  // The gateway has no working directory of its own: each project brings its settings (see runGatewayMode).
  if (opts.gateway) return await runGatewayMode(opts.gateway);
  const cwd = resolveToolPath(".", deps.cwd ?? process.cwd());
  const home = troposHome(env);
  const paths = settingsPaths(cwd, home);

  let settings: Settings;
  try {
    const loaded = await loadSettings(paths, { model: opts.model, effort: opts.effort, permissions: { allow: opts.allowedTools } });
    settings = loaded.settings;
    for (const warning of loaded.warnings) err(`tcode: ${warning}\n`);
  } catch (e) {
    if (e instanceof SettingsError) {
      err(`tcode: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  Object.assign(env, settings.env);
  const entered = await enterNativeSession(settings.autoUpdates, opts.print);
  if (entered !== undefined) return entered;
  const { rules, invalid } = compileRules(settings.permissions);
  for (const rule of invalid) err(`tcode: ignoring invalid permission rule "${rule}"\n`);

  const picked = pickShell(env.SHELL, (name) => Bun.which(name));
  const router = new ProviderRouter({ home, env, settings: settings.providers });
  // Usage errors come before any session file is created or extension started.
  if (opts.resume && !opts.resumeId && opts.print) {
    err("tcode: --resume needs a session id in print mode.\n");
    return EXIT_USAGE;
  }
  let printPrompt = "";
  if (opts.print) {
    const stdin = await (deps.readStdin ?? readPipedStdin)();
    printPrompt = [opts.prompt, stdin?.trimEnd()].filter(Boolean).join("\n\n");
    if (!printPrompt) {
      err('tcode: print mode needs a prompt, e.g. tcode -p "explain this repo"\n');
      return EXIT_USAGE;
    }
  } else if (!opts.gateway && (!process.stdin.isTTY || deps.readStdin)) {
    err("tcode: interactive mode needs a terminal. Use -p for scripts and pipes.\n");
    return EXIT_USAGE;
  }

  if (!opts.print && !opts.gateway && picked.rejected) {
    err(`tcode: using bash for commands (your shell ${picked.rejected} isn't POSIX-compatible)\n`);
  }

  await layoutAtStart(home, VERSION, err);
  const ext = await loadExtensions({ cwd, home, settings, env });
  // Warnings quote repo file names and server output: keep their escape sequences away from the terminal.
  const harness = await loadHarness({ home, cwd });
  for (const warning of [...ext.warnings, ...harnessWarnings(harness)]) err(`tcode: ${sanitizeForTerminal(warning)}\n`);
  const subagents: SubagentHolder = {};
  // The current session, for SessionSearch to skip; set once the session is open below.
  let sessionId = "";
  const ctx: AppContext = {
    cwd,
    home,
    version: VERSION,
    settings,
    rules,
    allowedDirs: [cwd, ...settings.additionalDirectories, ...opts.addDir].map((d) => resolveToolPath(d, cwd)),
    tools: sessionTools(createTools({ rgPath: Bun.which("rg") }), ext, { home, cwd, holder: subagents, sessionId: () => sessionId }),
    model: deps.model ?? router,
    providers: router,
    shell: picked.shell,
    localSettingsPath: paths.userProject,
    ext,
    subagents,
    env,
    modelPrefs: new ModelPrefs(home),
    role: "owner",
    secrets: new SecretVault(),
    system: harness.system,
  };
  // The owner's terminal can schedule too; results go to the owner's chat.
  ctx.tools = [...ctx.tools, await ownerCronTool(home)];
  // And change Tropos's setup, through the dashboard's own handlers; a running gateway is told to reload by signal.
  if (ctx.role === "owner") {
    ctx.tools = [
      ...ctx.tools,
      createSetupTool({ home, userHome: homedir(), who: { role: ctx.role, origin: "local" }, admin: sessionAdmin(home, env, homedir()), ledger: ext.ledger, reload: () => requestGatewayReload(home), secrets: ctx.secrets, providers: router }),
    ];
  }
  try {
    return await runSession();
  } finally {
    await Promise.all([ext.mcp?.close(), ext.lsp?.close()]);
  }

  async function runSession(): Promise<number> {
    let session: SessionStore;
    let history: MessageParam[] = [];
    try {
      if (opts.continue) {
        const latest = (await listSessions(home, cwd))[0];
        if (!latest) {
          err("tcode: there is no earlier session in this directory to continue.\n");
          return 1;
        }
        ({ store: session, messages: history } = await SessionStore.open(home, cwd, latest.id));
      } else if (opts.resumeId) {
        ({ store: session, messages: history } = await SessionStore.open(home, cwd, opts.resumeId));
      } else {
        session = await SessionStore.create(home, { cwd, model: settings.model, version: VERSION, role: ctx.role });
      }
    } catch (e) {
      err(`tcode: ${(e as Error).message}\n`);
      return 1;
    }

    sessionId = session.id;
    const mode: Mode = opts.dangerouslySkipPermissions ? "bypass" : (opts.permissionMode ?? "default");
    const resumed = Boolean(opts.continue || opts.resumeId);

    if (opts.print) {
      const renderer = new PrintRenderer(opts.outputFormat, out, err, session.id);
      const state = { model: settings.model, effort: settings.effort, mode };
      const hooks = sessionHooks(ctx, () => session, () => state.mode);
      const toolContext = createToolContext(ctx);
      // `tcode -p "/review main"` runs a custom command or skill, as typing it would.
      const slash = parseCommand(printPrompt, extraCommands(ext));
      let prompt = printPrompt;
      if (slash.kind === "custom") {
        const io = commandIO(ctx, () => state.mode, toolContext, { askPermission: async () => PRINT_DENY }, new AbortController().signal, hooks);
        const expanded = await expandSlash(ctx, slash.name, slash.args, io);
        if (!expanded.ok) {
          err(`tcode: /${slash.name}: ${expanded.reason}\n`);
          return 1;
        }
        prompt = expanded.prompt;
        if (expanded.model) state.model = expanded.model;
      }
      let context = await sessionStart(hooks, resumed ? "resume" : "startup", (_level, text) => err(`tcode: ${sanitizeForTerminal(text)}\n`), harnessNonce(session.id));
      const agent = makeAgent(ctx, {
        session: () => session,
        history,
        state: () => state,
        ui: { emit: (event) => renderer.emit(event), askPermission: async () => PRINT_DENY },
        toolContext,
        maxTurns: opts.maxTurns,
        hooks,
        pending: {
          take: () => {
            const text = context;
            context = null;
            return text;
          },
        },
      });
      const controller = new AbortController();
      const onSigint = () => controller.abort();
      process.once("SIGINT", onSigint);
      try {
        return await runPrint(agent, renderer, prompt, controller.signal);
      } finally {
        process.off("SIGINT", onSigint);
        await sessionEnd(hooks, "exit");
      }
    }

    const added = await autoRegisterProject(home, cwd);
    // The owner's terminal hears suggestions too (print mode above stays free of them): the block, the Suggestion tool, and
    // a watcher for this repo's pinned test commands when it is a registered project.
    const registered = (await loadGatewayConfig(home).catch(() => undefined))?.projects.find((p) => p.path === cwd);
    Object.assign(ctx, withSuggestions(ctx, { userHome: homedir(), projectId: registered?.id ?? added?.id ?? "default", testCommands: registered?.testCommands ?? [] }));
    ctx.tools = [...ctx.tools, suggestionTool(home)];
    const runtime = await createRuntime(ctx, {
      startNotices: added ? [`Added this repo to your projects as "${added.id}", so chats can work on it too. Don't want it there? Ask me to remove it.`] : undefined,
      session,
      history,
      mode,
      modes: MODES.filter((m) => m !== "bypass" || opts.dangerouslySkipPermissions),
      theme: resolveTheme(settings.theme, env),
      initialPrompt: opts.prompt,
      startWithPicker: opts.resume && !opts.resumeId,
      source: resumed ? "resume" : "startup",
    });
    const app = render(<App runtime={runtime} />, { exitOnCtrlC: false });
    try {
      await app.waitUntilExit();
    } finally {
      await closeRuntime(runtime, err);
    }
    return 0;
  }
}
