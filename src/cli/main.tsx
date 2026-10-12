import { render } from "ink";
import { AnthropicModel, createClient, type Model } from "../api/model";
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
import { CliError, parseCli, type CliOptions } from "./args";
import { PRINT_DENY, PrintRenderer, runPrint } from "./print";
import { createRuntime, createToolContext, makeAgent, type AppContext } from "./runtime";
import { USAGE } from "./usage";

/** sysexits.h EX_USAGE; distinct from print-mode exit codes (2 = refusal, 3 = max turns). */
export const EXIT_USAGE = 64;

export interface MainDeps {
  model?: Model;
  out?: (s: string) => void;
  err?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  readStdin?: () => Promise<string | null>;
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
    opts = parseCli(argv);
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
  const { rules, invalid } = compileRules(settings.permissions);
  for (const rule of invalid) err(`tropos: ignoring invalid permission rule "${rule}"\n`);

  const ctx: AppContext = {
    cwd,
    home,
    version: VERSION,
    settings,
    rules,
    allowedDirs: [cwd, ...settings.additionalDirectories, ...opts.addDir].map((d) => resolveToolPath(d, cwd)),
    tools: createTools({ rgPath: Bun.which("rg") }),
    model: deps.model ?? new AnthropicModel(createClient()),
    shell: env.SHELL ?? "/bin/bash",
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
