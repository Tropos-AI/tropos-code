import { render } from "ink";
import type { Model } from "../api/model";
import { ProviderRouter } from "../providers/router";
import { MODES, type Mode } from "../config/constants";
import { SettingsError, loadSettings, settingsPaths, type Settings } from "../config/settings";
import { compileRules } from "../permissions/engine";
import { troposHome } from "../paths";
import { SessionStore, listSessions, type MessageParam } from "../session/store";
import { resolveToolPath } from "../tools/paths";
import { createTools } from "../tools/registry";
import { App } from "../ui/App";
import { resolveTheme } from "../ui/theme";
import { VERSION } from "../version";
import { startNativeSession } from "../install/session";
import { runInstallCommand, type CommandContext } from "../install/commands";
import type { Channel } from "../install/channels";
import { CliError, parseInvocation, type CliOptions } from "./args";
import { PRINT_DENY, PrintRenderer, runPrint } from "./print";
import { createRuntime, createToolContext, makeAgent, type AppContext } from "./runtime";
import { USAGE } from "./usage";

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
  /** Tests override terminal detection for the native-session announcement. */
  tty?: { stdin: boolean; stdout: boolean };
}

const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

/**
 * The shell that runs Bash-tool commands. The wrapper script is POSIX, so $SHELL is used only
 * when it is bash, zsh, sh, dash or ksh; anything else (fish, tcsh, nu ...) falls back to bash.
 * `rejected` names the unsupported shell, when there was one.
 */
export function pickShell(envShell: string | undefined, which: (name: string) => string | null): { shell: string; rejected?: string } {
  const fallback = which("bash") ?? "/bin/bash";
  if (!envShell) return { shell: fallback };
  const name = envShell.slice(envShell.lastIndexOf("/") + 1);
  if (POSIX_SHELLS.has(name)) return { shell: envShell };
  return { shell: fallback, rejected: name };
}

async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const text = await Bun.stdin.text();
  return text.trim() ? text : null;
}

/** Runs the CLI. Any failure that isn't handled below becomes one `tropos: <message>` line and exit code 1. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (e) {
    const err = deps.err ?? ((s: string) => void process.stderr.write(s));
    err(`tropos: ${e instanceof Error ? e.message : String(e)}\n`);
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
          // A background update never fails loudly (spec 11): it falls back to defaults.
          if (!(e instanceof SettingsError)) throw e;
          if (!(cmd.kind === "update" && cmd.background)) {
            err(`tropos: ${e.message}\n`);
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
      });
    }
    opts = invocation.options;
  } catch (e) {
    if (e instanceof CliError) {
      err(`tropos: ${e.message}\nRun tropos --help for usage.\n`);
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
  const cwd = resolveToolPath(".", deps.cwd ?? process.cwd());
  const home = troposHome(env);
  const paths = settingsPaths(cwd, home);

  let settings: Settings;
  try {
    const loaded = await loadSettings(paths, { model: opts.model, effort: opts.effort, permissions: { allow: opts.allowedTools } });
    settings = loaded.settings;
    for (const warning of loaded.warnings) err(`tropos: ${warning}\n`);
  } catch (e) {
    if (e instanceof SettingsError) {
      err(`tropos: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  Object.assign(env, settings.env);
  const native = await startNativeSession({
    env,
    execPath: deps.execPath ?? process.execPath,
    print: opts.print,
    stdinTTY: deps.tty?.stdin ?? (Boolean(process.stdin.isTTY) && !deps.readStdin),
    stdoutTTY: deps.tty?.stdout ?? Boolean(process.stdout.isTTY),
    autoUpdates: settings.autoUpdates,
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
  const { rules, invalid } = compileRules(settings.permissions);
  for (const rule of invalid) err(`tropos: ignoring invalid permission rule "${rule}"\n`);

  const picked = pickShell(env.SHELL, (name) => Bun.which(name));
  const router = new ProviderRouter({ home, env, settings: settings.providers });
  const ctx: AppContext = {
    cwd,
    home,
    version: VERSION,
    settings,
    rules,
    allowedDirs: [cwd, ...settings.additionalDirectories, ...opts.addDir].map((d) => resolveToolPath(d, cwd)),
    tools: createTools({ rgPath: Bun.which("rg") }),
    model: deps.model ?? router,
    providers: router,
    shell: picked.shell,
    localSettingsPath: paths.userProject,
  };

  // Usage errors come before any session file is created.
  if (opts.resume && !opts.resumeId && opts.print) {
    err("tropos: --resume needs a session id in print mode.\n");
    return EXIT_USAGE;
  }
  let printPrompt = "";
  if (opts.print) {
    const stdin = await (deps.readStdin ?? readPipedStdin)();
    printPrompt = [opts.prompt, stdin?.trimEnd()].filter(Boolean).join("\n\n");
    if (!printPrompt) {
      err('tropos: print mode needs a prompt, e.g. tropos -p "explain this repo"\n');
      return EXIT_USAGE;
    }
  } else if (!process.stdin.isTTY || deps.readStdin) {
    err("tropos: interactive mode needs a terminal. Use -p for scripts and pipes.\n");
    return EXIT_USAGE;
  }

  if (!opts.print && picked.rejected) {
    err(`tropos: using bash for commands (your shell ${picked.rejected} isn't POSIX-compatible)\n`);
  }

  let session: SessionStore;
  let history: MessageParam[] = [];
  try {
    if (opts.continue) {
      const latest = (await listSessions(home, cwd))[0];
      if (!latest) {
        err("tropos: there is no earlier session in this directory to continue.\n");
        return 1;
      }
      ({ store: session, messages: history } = await SessionStore.open(home, cwd, latest.id));
    } else if (opts.resumeId) {
      ({ store: session, messages: history } = await SessionStore.open(home, cwd, opts.resumeId));
    } else {
      session = await SessionStore.create(home, { cwd, model: settings.model, version: VERSION });
    }
  } catch (e) {
    err(`tropos: ${(e as Error).message}\n`);
    return 1;
  }

  const mode: Mode = opts.dangerouslySkipPermissions ? "bypass" : (opts.permissionMode ?? "default");

  if (opts.print) {
    const renderer = new PrintRenderer(opts.outputFormat, out, err, session.id);
    const state = { model: settings.model, effort: settings.effort, mode };
    const agent = makeAgent(ctx, {
      session: () => session,
      history,
      state: () => state,
      ui: { emit: (event) => renderer.emit(event), askPermission: async () => PRINT_DENY },
      toolContext: createToolContext(ctx),
      maxTurns: opts.maxTurns,
    });
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      return await runPrint(agent, renderer, printPrompt, controller.signal);
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  const runtime = await createRuntime(ctx, {
    session,
    history,
    mode,
    modes: MODES.filter((m) => m !== "bypass" || opts.dangerouslySkipPermissions),
    theme: resolveTheme(settings.theme, env),
    initialPrompt: opts.prompt,
    startWithPicker: opts.resume && !opts.resumeId,
  });
  const app = render(<App runtime={runtime} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  return 0;
}
