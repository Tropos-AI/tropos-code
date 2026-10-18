// src/cli/lifecycle/onboard.ts — `tcode onboard`: the first-run wizard (provider, model, Telegram, sandbox, service,
// health, dashboard), interactive or with flags. Keys come from a prompt or an environment variable, never from argv.
import { parseFlags } from "../../doctor/flags";
import { pidAlive } from "../../doctor/util";
import {
  computeOnboardState,
  detectProviders,
  finish,
  healthReport,
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
  effectiveModel,
  type OnboardDeps,
  type OnboardDepsInput,
} from "../../onboard/engine";
import { allProviders } from "../../providers/router";
import { readSettingsFile } from "../../config/settings";
import { join } from "node:path";
import type { OnboardState, OnboardStepId } from "../../web/admin/api";
import { dashboardLoginLink } from "../../web/links";
import { runningDashboard } from "./dashboard";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode onboard [options]

Guided first-run setup: connect a model provider, choose a model, optionally connect
Telegram, install the background service, check health and open the dashboard. Safe to run again; it only asks about what is not set up yet.

Options:
  --reset                    ask every step again
  --quick                    accept the defaults without asking
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

export const RISK_NOTICE = [
  "Tropos reads and edits files and runs commands in the folders you point it at; it asks before anything risky.",
  "Your provider key is stored only on this machine, in ~/.tropos/credentials.json (mode 0600), and sent only to that provider.",
  "Chats from Telegram run in a Docker sandbox, confined to one project folder, and ask before running commands.",
  "You can review or undo all of this later with `tcode status`, `tcode doctor` and `tcode uninstall`.",
];

export interface OnboardCliDeps {
  /** Overrides for the engine's machine access (network, Docker, service manager, doctor). */
  engine?: Omit<OnboardDepsInput, "home">;
  openBrowser?: (url: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
}

const BOOL = ["help", "reset", "quick", "no-open", "non-interactive", "accept-risk", "install-service", "skip-telegram", "skip-service", "skip-sandbox", "json"];
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
  if (!nonInteractive && !ctx.interactive) return usage(ctx, "this needs a terminal. Use --non-interactive --accept-risk with --provider and --api-key-env.");
  if (nonInteractive && !f.has("accept-risk")) return usage(ctx, "--non-interactive needs --accept-risk (it confirms the notice shown by `tcode onboard`).");
  for (const name of ["api-key-env", "telegram-token-env"]) {
    const value = v.get(name);
    if (value !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return usage(ctx, `--${name} takes the NAME of an environment variable, not a value.`);
  }

  const deps = makeOnboardDeps({ home: ctx.home, userHome: ctx.userHome, env: ctx.env, now: ctx.now, execPath: ctx.execPath, scriptPath: ctx.scriptPath, ...cli.engine });
  if (v.has("provider") && !allProviders((await readSettingsFile(join(ctx.home, "settings.json")).catch(() => null))?.providers ?? {}).some((p) => p.id === v.get("provider"))) {
    return usage(ctx, `unknown provider "${v.get("provider")}".`);
  }
  const wizard = new Wizard(ctx, deps, cli, { quick: f.has("quick"), noOpen: f.has("no-open"), json });
  if (f.has("reset")) await reopen(deps);
  if (!nonInteractive) {
    ctx.out(`${RISK_NOTICE.map((l) => `  ${l}`).join("\n")}\n\n`);
    if (!f.has("accept-risk") && !(await ctx.confirm("Do you understand and want to continue?", false))) {
      ctx.err("Setup cancelled; nothing was changed.\n");
      return 1;
    }
  }
  return nonInteractive
    ? wizard.runFlags({ provider: v.get("provider"), keyEnv: v.get("api-key-env"), model: v.get("model"), telegramEnv: v.get("telegram-token-env"), skipTelegram: f.has("skip-telegram"), skipService: f.has("skip-service"), installService: f.has("install-service") })
    : wizard.runInteractive({ reset: f.has("reset") });
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

class Wizard {
  private readonly skipped = new Set<OnboardStepId>();
  private readonly problems: string[] = [];

  constructor(
    private readonly ctx: LifecycleContext,
    private readonly deps: OnboardDeps,
    private readonly cli: OnboardCliDeps,
    private readonly opt: { quick: boolean; noOpen: boolean; json: boolean },
  ) {}

  private say(text: string): void {
    if (!this.opt.json) this.ctx.out(`${text}\n`);
  }

  /** A yes/no question; `--quick` takes the default without asking. */
  private async ask(question: string, defaultYes: boolean): Promise<boolean> {
    return this.opt.quick ? defaultYes : this.ctx.confirm(question, defaultYes);
  }

  private status(state: OnboardState, id: OnboardStepId) {
    return state.steps.find((s) => s.id === id)!;
  }

  // ---- non-interactive ----

  async runFlags(a: FlagInput): Promise<number> {
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

  // ---- interactive ----

  async runInteractive(o: { reset: boolean }): Promise<number> {
    const { ctx } = this;
    let state = await computeOnboardState(this.deps, { health: false });
    ctx.out(`What I found:\n${renderState(state)}\n`);
    const todo = (id: OnboardStepId) => o.reset || ["todo", "warn"].includes(this.status(state, id).status);
    const refresh = async () => void (state = await computeOnboardState(this.deps, { health: false }));

    if (todo("provider") && !(await this.providerStep())) return 1;
    await refresh();
    if (todo("model") && !(await this.modelStep())) return 1;
    await refresh();
    if (todo("telegram") && this.status(state, "telegram").status !== "skipped") await this.telegramStep();
    await refresh();
    if (this.status(state, "service").status !== "skipped" && (o.reset || this.status(state, "service").status === "todo")) await this.serviceStep();

    await this.healthStep();
    state = await finish(this.deps, { skipped: [...this.skipped] });
    ctx.out(`\nSetup ${state.complete ? "is complete" : "is not complete"}:\n${renderState(state)}`);
    if (!state.complete) return 1;
    await this.dashboardStep();
    return 0;
  }

  private async providerStep(): Promise<boolean> {
    const { ctx } = this;
    const all = await detectProviders(this.deps);
    const withEnv = all.find((p) => p.source === "env");
    let chosen = withEnv && (await this.ask(`Use ${withEnv.info.name} (key found in $${withEnv.envName})?`, true)) ? withEnv : undefined;
    if (!chosen) {
      ctx.out("Providers:\n");
      all.forEach((p, i) => ctx.out(`  ${String(i + 1).padStart(2)}. ${p.info.name} (${p.info.id})${p.source ? "  - connected" : ""}\n`));
      const answer = (await ctx.prompt("Which one? (number or id)", { default: "1" })).trim();
      chosen = all[Number(answer) - 1] ?? all.find((p) => p.info.id === answer.toLowerCase());
      if (!chosen) {
        ctx.err(`"${answer}" is not in the list.\n`);
        return false;
      }
    }
    const { info } = chosen;
    if (chosen.source === "env" || (chosen.source && !info.keyRequired)) {
      const check = await validateKey(this.deps, { provider: info.id, key: chosen.source === "env" ? (ctx.env[chosen.envName!] ?? "") : "" });
      if (!check.ok) {
        ctx.err(`${info.name} did not accept it: ${check.error}\n`);
        return false;
      }
      ctx.out(`${info.name} works (${check.models.length} models).\n`);
      return true;
    }
    if (!info.keyRequired) {
      const check = await validateKey(this.deps, { provider: info.id, key: "" });
      if (check.ok) return true;
      ctx.err(`${info.name} is not answering: ${check.error}\nStart the server and run \`tcode onboard\` again.\n`);
      return false;
    }
    if (info.keyURL) ctx.out(`Create a key at ${info.keyURL}\n`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const key = (await ctx.prompt(`${info.name} API key (hidden; leave empty to cancel)`, { secret: true })).trim();
      if (!key) return false;
      const check = await validateKey(this.deps, { provider: info.id, key });
      if (check.ok) {
        await saveKey(this.deps, { provider: info.id, key });
        ctx.out(`Key works (${check.models.length} models) and is saved in ~/.tropos/credentials.json.\n`);
        return true;
      }
      ctx.err(`That key did not work: ${check.error}\n`);
    }
    return false;
  }

  private async modelStep(): Promise<boolean> {
    const { ctx } = this;
    const connected = (await detectProviders(this.deps)).filter((p) => p.source);
    const current = (await effectiveModel(this.deps.home)).model;
    const slash = current.indexOf("/");
    const owner = connected.find((p) => p.info.id === (slash > 0 ? current.slice(0, slash) : "anthropic")) ?? connected[0];
    if (!owner) return false;
    const listing = await listModels(this.deps, owner.info.id);
    const fallback = listing.models.length ? pickDefaultModel(owner.info.id, listing.models) : undefined;
    const keep = owner.info.id === (slash > 0 ? current.slice(0, slash) : "anthropic") ? current : undefined;
    const bareDefault = fallback;
    const def = keep && !this.opt.quick ? keep : bareDefault ? modelIdFor(owner.info.id, bareDefault) : current;
    let model = def;
    if (!this.opt.quick) {
      if (listing.models.length) {
        ctx.out("Models:\n");
        listing.models.slice(0, 15).forEach((m, i) => ctx.out(`  ${String(i + 1).padStart(2)}. ${m}\n`));
        if (listing.models.length > 15) ctx.out(`  ... and ${listing.models.length - 15} more; type an id\n`);
      } else ctx.err(`Could not list models${listing.error ? ` (${listing.error})` : ""}; type an id.\n`);
      const answer = (await ctx.prompt("Model (number or id)", { default: def })).trim();
      const byNumber = listing.models[Number(answer) - 1];
      model = byNumber ? modelIdFor(owner.info.id, byNumber) : answer === def ? def : answer.includes("/") || owner.info.id === "anthropic" ? answer : modelIdFor(owner.info.id, answer);
    }
    await saveModel(this.deps, model);
    ctx.out(`Model: ${model}\n`);
    return true;
  }

  private async telegramStep(): Promise<void> {
    const { ctx } = this;
    if (this.opt.quick || !(await ctx.confirm("Connect a Telegram bot so you can chat from your phone?", false))) {
      this.skipped.add("telegram");
      return;
    }
    ctx.out("Create a bot with @BotFather in Telegram and copy its token.\n");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const token = (await ctx.prompt("Bot token (hidden; leave empty to skip)", { secret: true })).trim();
      if (!token) break;
      const me = await verifyTelegram(this.deps, token);
      if (me.ok) {
        await saveTelegram(this.deps, token);
        ctx.out(`Connected to @${me.username || "your bot"}. Message it to get a pairing code, then run: tcode pairing approve telegram <code>\n`);
        return;
      }
      ctx.err(`Telegram did not accept it: ${me.error}\n`);
    }
    this.skipped.add("telegram");
  }

  private async serviceStep(): Promise<void> {
    const { ctx } = this;
    if (!(await this.ask("Keep the gateway running in the background (starts at login)?", true))) {
      this.skipped.add("service");
      return;
    }
    try {
      const { unitPath, hint } = await installService(this.deps);
      ctx.out(`Background service installed (${unitPath}).\n${hint ? `${hint}\n` : ""}`);
    } catch (err) {
      ctx.err(`Could not install the service: ${err instanceof Error ? err.message : "failed"}\nYou can run \`tcode gateway\` yourself instead.\n`);
      this.skipped.add("service");
    }
  }

  private async healthStep(): Promise<void> {
    const report = await healthReport(this.deps).catch(() => null);
    if (!report) return this.ctx.out("The health check could not run; try `tcode doctor`.\n");
    const { ok, warn, error } = report.summary;
    this.ctx.out(`\nHealth: ${ok} ok, ${warn} warning${warn === 1 ? "" : "s"}, ${error} error${error === 1 ? "" : "s"}\n`);
    for (const f of report.findings.filter((x) => x.level === "warn" || x.level === "error").slice(0, 8)) this.ctx.out(`  - ${f.message}\n`);
    if (warn + error) this.ctx.out("Run `tcode doctor` for details and fixes.\n");
  }

  private async dashboardStep(): Promise<void> {
    const { ctx } = this;
    const sleep = this.cli.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let target = await runningDashboard(ctx.home, this.cli.alive);
    // A service that was just started needs a moment to write its state file.
    for (let i = 0; !target && i < 10 && (await this.deps.service.status().catch(() => null))?.running; i++) {
      await sleep(300);
      target = await runningDashboard(ctx.home, this.cli.alive);
    }
    if (!target) {
      ctx.out("\nThe gateway is not running. Start it with `tcode gateway` (or `tcode gateway install`), then open the dashboard with `tcode dashboard`.\n");
      return;
    }
    if (this.opt.noOpen || !(await this.ask("Open the web dashboard now?", true))) {
      ctx.out(`\nOpen the dashboard any time with: tcode dashboard  (${target.url})\n`);
      return;
    }
    // The one-time link logs this browser in; it is issued only when it is about to be opened.
    const link = await dashboardLoginLink(ctx.home, target.port);
    await (this.cli.openBrowser ?? (async (u: string) => (await import("../../web/serve")).openInBrowser(u)))(link);
    ctx.out(`Opened ${target.url}\n`);
  }
}

const run: LifecycleRun = (argv, ctx) => runOnboard(argv, ctx);
export default run;
