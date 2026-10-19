// src/cli/lifecycle/onboard.ts — `tcode onboard`: the first-run wizard, interactive (onboard-wizard.ts) or with flags.
// Keys come from a prompt or an environment variable, never from argv.
import { parseFlags } from "../../doctor/flags";
import {
  computeOnboardState,
  detectProviders,
  finish,
  installService,
  listModels,
  makeOnboardDeps,
  modelIdFor,
  pickDefaultModel,
  reopen,
  saveKey,
  saveModel,
  saveTelegram,
  validateKey,
  verifyTelegram,
  type OnboardDeps,
  type OnboardDepsInput,
} from "../../onboard/engine";
import { RISK_NOTICE } from "../../onboard/copy";
import { flowForContext, type Flow } from "../../ui/flow";
import { layoutAtStart } from "../../home/migrate";
import { runWizard } from "./onboard-wizard";
import { allProviders } from "../../providers/router";
import { readSettingsFile } from "../../config/settings";
import { join } from "node:path";
import type { OnboardState, OnboardStepId } from "../../web/admin/api";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode onboard [options]

Guided first-run setup, one short step at a time: a model provider and model, a name for your agent,
your projects, how much chats may do on their own, Telegram, phone access and the background service.
Safe to run again; it only asks about what is not set up yet.

Options:
  --reset                    ask every step again
  --quick                    accept the defaults without asking
  --advanced                 ask about every option and list every model
  --no-open                  do not open the dashboard at the end
  --non-interactive          no questions (needs --accept-risk)
  --accept-risk              confirm the notice below without being asked
  --provider <id>            provider to use (non-interactive)
  --api-key-env <VAR>        read the provider key from this environment variable
  --model <id>               model to use (non-interactive)
  --telegram-token-env <VAR> read the Telegram bot token from this environment variable
  --install-service          install the background service
  --skip-telegram            skip Telegram
  --skip-service             skip the background service
  --skip-sandbox             accepted for older scripts; does nothing
  --json                     print the result as JSON (non-interactive)
  --help                     show this text

Keys are never accepted as arguments: they would end up in your shell history.
`;

export { RISK_NOTICE };

export interface OnboardCliDeps {
  /** Overrides for the engine's machine access (network, Docker, service manager, doctor). */
  engine?: Omit<OnboardDepsInput, "home">;
  openBrowser?: (url: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  /** How long the Telegram step waits for the owner's first message (ms). */
  telegramWaitMs?: number;
  /** The terminal the wizard draws on. Tests pass a scripted one; the default reads keys when stdin is a terminal. */
  flow?: Flow;
}

const BOOL = ["help", "reset", "quick", "advanced", "no-open", "non-interactive", "accept-risk", "install-service", "skip-telegram", "skip-service", "skip-sandbox", "json"];
const VALUE = ["provider", "api-key-env", "model", "telegram-token-env"];
/** Flags that would put a secret on the command line. */
const SECRET_FLAGS = /^--(api-key|apikey|key|token|telegram-token|bot-token)(=|$)/;

function usage(ctx: LifecycleContext, message: string): number {
  ctx.err(`tcode onboard: ${message}\nRun \`tcode onboard --help\` for usage.\n`);
  return 64;
}

const mark = (s: OnboardState["steps"][number]): string => ({ done: "[x]", todo: "[ ]", skipped: "[-]", warn: "[!]", error: "[!]" })[s.status];

function renderState(state: OnboardState): string {
  return state.steps.map((s) => `  ${mark(s)} ${s.title}${s.detail ? `  (${s.detail})` : ""}`).join("\n") + "\n";
}

export async function runOnboard(argv: string[], ctx: LifecycleContext, cli: OnboardCliDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.out(HELP);
    return 0;
  }
  if (argv.some((a) => SECRET_FLAGS.test(a))) {
    return usage(ctx, "keys are not accepted as arguments (they would be saved in your shell history). Use --api-key-env <VAR> or answer the prompt.");
  }
  const parsed = parseFlags(argv, { bool: BOOL, value: VALUE });
  if (!parsed.ok || parsed.rest.length) return usage(ctx, parsed.ok ? `unexpected argument ${parsed.rest[0]}` : parsed.error);
  const f = parsed.bool;
  const v = parsed.value;
  const nonInteractive = f.has("non-interactive");
  const json = f.has("json");
  if (json && !nonInteractive) return usage(ctx, "--json needs --non-interactive.");
  if (f.has("install-service") && f.has("skip-service")) return usage(ctx, "--install-service and --skip-service contradict each other.");
  if (f.has("advanced") && (f.has("quick") || nonInteractive)) return usage(ctx, "--advanced asks more questions; it cannot go with --quick or --non-interactive.");
  if (!nonInteractive && !ctx.interactive) return usage(ctx, "this needs a terminal. Use --non-interactive --accept-risk with --provider and --api-key-env.");
  if (nonInteractive && !f.has("accept-risk")) return usage(ctx, "--non-interactive needs --accept-risk (it confirms the notice shown by `tcode onboard`).");
  for (const name of ["api-key-env", "telegram-token-env"]) {
    const value = v.get(name);
    if (value !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return usage(ctx, `--${name} takes the NAME of an environment variable, not a value.`);
  }

  await layoutAtStart(ctx.home, ctx.version, ctx.err, ctx.now);
  const deps = makeOnboardDeps({ home: ctx.home, userHome: ctx.userHome, env: ctx.env, now: ctx.now, execPath: ctx.execPath, scriptPath: ctx.scriptPath, ...cli.engine });
  if (v.has("provider") && !allProviders((await readSettingsFile(join(ctx.home, "settings.json")).catch(() => null))?.providers ?? {}).some((p) => p.id === v.get("provider"))) {
    return usage(ctx, `unknown provider "${v.get("provider")}".`);
  }
  if (!nonInteractive) {
    const opt = { quick: f.has("quick"), advanced: f.has("advanced"), noOpen: f.has("no-open"), reset: f.has("reset"), acceptRisk: f.has("accept-risk") };
    return runWizard({ ctx, deps, cli, opt, flow: cli.flow ?? flowForContext(ctx) });
  }
  if (f.has("reset")) await reopen(deps);
  const runner = new FlagRun(ctx, deps, { json });
  return runner.run({ provider: v.get("provider"), keyEnv: v.get("api-key-env"), model: v.get("model"), telegramEnv: v.get("telegram-token-env"), skipTelegram: f.has("skip-telegram"), skipService: f.has("skip-service"), installService: f.has("install-service") });
}

interface FlagInput {
  provider?: string;
  keyEnv?: string;
  model?: string;
  telegramEnv?: string;
  skipTelegram: boolean;
  skipService: boolean;
  installService: boolean;
}

/** `--non-interactive`: everything comes from flags and environment variables; the result is a checklist or JSON. */
class FlagRun {
  private readonly skipped = new Set<OnboardStepId>();
  private readonly problems: string[] = [];

  constructor(
    private readonly ctx: LifecycleContext,
    private readonly deps: OnboardDeps,
    private readonly opt: { json: boolean },
  ) {}

  async run(a: FlagInput): Promise<number> {
    let state = await computeOnboardState(this.deps, { health: false });
    const fail = (message: string) => {
      this.problems.push(message);
      return this.report(state, false);
    };

    // provider
    let provider = a.provider;
    if (a.keyEnv) {
      if (!provider) return fail("--api-key-env needs --provider.");
      const key = (this.ctx.env[a.keyEnv] ?? "").trim();
      if (!key) return fail(`The environment variable ${a.keyEnv} is empty or not set.`);
      const check = await validateKey(this.deps, { provider, key });
      if (!check.ok) return fail(`The ${provider} key was not accepted: ${check.error}`);
      await saveKey(this.deps, { provider, key });
    } else if (provider) {
      const have = (await detectProviders(this.deps)).find((p) => p.info.id === provider);
      if (!have?.source) return fail(`${provider} has no key yet. Set one with --api-key-env <VAR>.`);
    } else {
      const connected = (await detectProviders(this.deps)).filter((p) => p.source);
      if (!connected.length) return fail("No provider is connected. Pass --provider <id> --api-key-env <VAR>.");
      provider = connected[0]!.info.id;
    }

    // model
    const listing = await listModels(this.deps, provider);
    if (a.model) {
      const id = a.model.includes("/") && provider !== "anthropic" ? a.model : modelIdFor(provider, a.model);
      const bare = id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
      if (listing.ok && listing.models.length && !listing.models.includes(bare)) return fail(`${provider} does not offer a model called "${bare}".`);
      await saveModel(this.deps, id);
    } else if (a.provider || a.keyEnv) {
      const picked = pickDefaultModel(provider, listing.models);
      if (picked) await saveModel(this.deps, modelIdFor(provider, picked));
    }

    // telegram
    if (a.telegramEnv) {
      const token = (this.ctx.env[a.telegramEnv] ?? "").trim();
      if (!token) return fail(`The environment variable ${a.telegramEnv} is empty or not set.`);
      const me = await verifyTelegram(this.deps, token);
      if (!me.ok) return fail(`Telegram did not accept the bot token: ${me.error}`);
      await saveTelegram(this.deps, token);
    } else if (a.skipTelegram) this.skipped.add("telegram");

    // service
    if (a.skipService) this.skipped.add("service");
    else if (a.installService) {
      try {
        await installService(this.deps);
      } catch (err) {
        return fail(`Could not install the service: ${err instanceof Error ? err.message : "failed"}`);
      }
    }

    state = await finish(this.deps, { skipped: [...this.skipped] });
    return this.report(state, state.complete);
  }

  private report(state: OnboardState, ok: boolean): number {
    if (this.opt.json) this.ctx.out(`${JSON.stringify({ ok, complete: state.complete, steps: state.steps, problems: this.problems }, null, 2)}\n`);
    else {
      this.ctx.out(renderState(state));
      for (const p of this.problems) this.ctx.err(`${p}\n`);
    }
    return ok ? 0 : 1;
  }
}

const run: LifecycleRun = (argv, ctx) => runOnboard(argv, ctx);
export default run;
