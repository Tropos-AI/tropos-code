// src/cli/lifecycle/security.ts — `tcode security audit`: the doctor's security area plus the secret-file permission check.
import { runDoctor } from "../../doctor/engine";
import { parseFlags } from "../../doctor/flags";
import { hasUnfixed, renderReport, reportJson } from "../../doctor/render";
import type { DoctorOptions } from "../../doctor/types";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode security audit [options]

Reviews what an attacker (or a mistaken agent) could reach: secret file
permissions, the gateway web token, the chat sandbox's network, paired Telegram
senders, broad allow rules, bypass defaults, hooks, MCP servers and project
directories.

Options:
  --fix     tighten file permissions (chmod only); nothing else is changed
  --deep    also check that Telegram accepts the bot token
  --json    print the report as JSON
  --help    show this text

Exit status: 0 no errors, 1 an error remains, 64 usage error.
`;

export type SecurityDeps = Pick<DoctorOptions, "runner" | "checks" | "platform">;

export async function runSecurityCommand(argv: string[], ctx: LifecycleContext, deps: SecurityDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.out(HELP);
    return 0;
  }
  const usage = (msg: string) => {
    ctx.err(`tcode security: ${msg}\nRun \`tcode security --help\` for usage.\n`);
    return 64;
  };
  const parsed = parseFlags(argv, { bool: ["fix", "deep", "json"], value: [] });
  if (!parsed.ok) return usage(parsed.error);
  if (parsed.rest[0] !== "audit" || parsed.rest.length > 1) return usage(parsed.rest.length ? `unknown subcommand ${parsed.rest[0]}` : "missing subcommand (audit)");
  const deep = parsed.bool.has("deep");
  const report = await runDoctor({
    home: ctx.home,
    userHome: ctx.userHome,
    env: ctx.env,
    cwd: ctx.cwd,
    now: ctx.now,
    deep,
    only: deep ? ["security", "permissions", "gateway.config"] : ["security", "permissions"],
    // Only the safe fixes exist for these checks (chmod); anything else is left to the owner.
    fix: parsed.bool.has("fix") ? "safe" : false,
    ...deps,
  });
  ctx.out(parsed.bool.has("json") ? reportJson(report) : renderReport(report, "Tropos security audit"));
  if (!parsed.bool.has("json") && !parsed.bool.has("fix") && hasUnfixed(report)) ctx.out("Run `tcode security audit --fix` to tighten file permissions.\n");
  return report.summary.error > 0 ? 1 : 0;
}

const run: LifecycleRun = (argv, ctx) => runSecurityCommand(argv, ctx);
export default run;
