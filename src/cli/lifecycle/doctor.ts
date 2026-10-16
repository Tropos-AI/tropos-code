// src/cli/lifecycle/doctor.ts — `tcode doctor`: check the install, configuration and sandbox; --fix repairs what it can.
import { runDoctor } from "../../doctor/engine";
import { parseFlags } from "../../doctor/flags";
import { hasUnfixed, renderReport, reportJson } from "../../doctor/render";
import type { DoctorOptions } from "../../doctor/types";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode doctor [options]

Checks the installation, settings, providers, secret file permissions, Docker,
the gateway, projects and MCP servers, and says what to do about each problem.

Options:
  --fix            apply fixes. On a terminal each one is confirmed first;
                   without a terminal only safe ones run (chmod, removing a
                   stale gateway state file)
  --yes            with --fix: apply every fix without asking
  --deep           also make network calls: list models with each provider key,
                   ask Telegram who the bot is
  --only <id|area> run one check or area (install, settings, providers,
                   permissions, docker, gateway, workspace, sessions, config,
                   mcp, tools, or a check id such as gateway.state)
  --json           print the report as JSON
  --lint           read-only; exit 1 if any error was found (for scripts, CI)
  --strict         with --lint: also exit 2 when there are only warnings
  --help           show this text

Exit status: 0 no errors remain, 1 an error remains, 2 warnings with
--lint --strict, 64 usage error.
`;

export type DoctorDeps = Pick<DoctorOptions, "runner" | "checks" | "platform">;

export async function runDoctorCommand(argv: string[], ctx: LifecycleContext, deps: DoctorDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.out(HELP);
    return 0;
  }
  const parsed = parseFlags(argv, { bool: ["fix", "yes", "json", "lint", "strict", "deep"], value: ["only"] });
  const usage = (msg: string) => {
    ctx.err(`tcode doctor: ${msg}\nRun \`tcode doctor --help\` for usage.\n`);
    return 64;
  };
  if (!parsed.ok) return usage(parsed.error);
  const { bool } = parsed;
  if (parsed.rest.length) return usage(`unexpected argument ${parsed.rest[0]}`);
  if (bool.has("lint") && bool.has("fix")) return usage("--lint is read-only and cannot be combined with --fix");
  if (bool.has("strict") && !bool.has("lint")) return usage("--strict only applies with --lint");
  if (bool.has("yes") && !bool.has("fix")) return usage("--yes only applies with --fix");

  const json = bool.has("json");
  const fix = bool.has("fix");
  // Questions go to a terminal; a JSON run is for scripts, so it asks nothing.
  const ask = fix && !bool.has("yes") && ctx.interactive && !json;
  const report = await runDoctor({
    home: ctx.home,
    userHome: ctx.userHome,
    env: ctx.env,
    cwd: ctx.cwd,
    now: ctx.now,
    deep: bool.has("deep"),
    only: parsed.value.get("only"),
    fix: fix ? (bool.has("yes") || ask ? true : "safe") : false,
    confirm: ask ? (f) => ctx.confirm(`Fix: ${f.message}?${f.detail ? `\n  ${f.detail.split("\n")[0]}\n` : ""}`, true) : undefined,
    ...deps,
  });

  if (parsed.value.has("only") && report.findings.length === 0) return usage(`no check matches --only ${parsed.value.get("only")}`);
  ctx.out(json ? reportJson(report) : renderReport(report));
  if (!json && !fix && hasUnfixed(report)) ctx.out("Run `tcode doctor --fix` to apply the fixes marked [fixable].\n");
  if (!json && fix && !bool.has("yes") && !ask && hasUnfixed(report)) ctx.out("Without a terminal only safe fixes run; add --yes to apply the rest.\n");
  if (report.summary.error > 0) return 1;
  if (bool.has("lint") && bool.has("strict") && report.summary.warn > 0) return 2;
  return 0;
}

const run: LifecycleRun = (argv, ctx) => runDoctorCommand(argv, ctx);
export default run;
