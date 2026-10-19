// test/helpers/cli-cases.ts
import { CliError, parseCli, type CliOptions } from "../../src/cli/args";

export interface CliCase {
  argv: string[];
  note: string;
}

const ID = "3f2b8c1e-9a4d-4e2f-8b1c-0d9e8f7a6b5c";

/** Every invocation shape we promise to keep. Never remove a case; only add. */
export const CLI_CASES: readonly CliCase[] = [
  { argv: [], note: "no arguments" },
  { argv: ["hello"], note: "one-word prompt" },
  { argv: ["hello", "world"], note: "multi-word prompt" },
  { argv: ["-p", "x"], note: "print short" },
  { argv: ["--print", "x"], note: "print long" },
  { argv: ["-p", "x", "--output-format", "json"], note: "json output" },
  { argv: ["-p", "x", "--output-format", "stream-json"], note: "stream-json output" },
  { argv: ["--output-format", "xml"], note: "bad output format" },
  { argv: ["--max-turns", "3", "-p", "x"], note: "max turns" },
  { argv: ["--max-turns", "0"], note: "max turns zero" },
  { argv: ["--max-turns", "1.5"], note: "max turns fractional" },
  { argv: ["--allowed-tools", "Read,Bash(git diff:*)"], note: "allowed tools" },
  { argv: ["--allowed-tools", "A", "--allowed-tools", "B"], note: "allowed tools repeated" },
  { argv: ["--model", "claude-sonnet-5-5"], note: "model" },
  { argv: ["--model", "deepseek/deepseek-flash"], note: "provider model" },
  { argv: ["--effort", "max"], note: "effort" },
  { argv: ["--effort", "huge"], note: "bad effort" },
  { argv: ["-c"], note: "continue short" },
  { argv: ["--continue"], note: "continue long" },
  { argv: ["-r"], note: "resume picker" },
  { argv: ["--resume"], note: "resume picker long" },
  { argv: ["-r", ID], note: "resume id" },
  { argv: ["--resume", ID, "fix", "it"], note: "resume id with prompt" },
  { argv: ["-r", "not-a-uuid"], note: "resume with non-uuid word" },
  { argv: ["-c", "-r"], note: "continue and resume" },
  { argv: ["--permission-mode", "plan"], note: "permission mode" },
  { argv: ["--permission-mode", "bypass"], note: "bypass mode rejected" },
  { argv: ["--permission-mode", "nope"], note: "bad permission mode" },
  { argv: ["--dangerously-skip-permissions"], note: "skip permissions" },
  { argv: ["--add-dir", "../x", "--add-dir", "/y"], note: "add dirs" },
  { argv: ["-h"], note: "help short" },
  { argv: ["--help"], note: "help long" },
  { argv: ["-v"], note: "version short" },
  { argv: ["--version"], note: "version long" },
  { argv: ["--bogus"], note: "unknown long flag" },
  { argv: ["-x"], note: "unknown short flag" },
  { argv: ["--", "-p"], note: "double dash then flag-like word" },
  { argv: ["--", "install"], note: "double dash then subcommand word" },
  { argv: ["install"], note: "bare install (becomes a subcommand)" },
  { argv: ["install", "stable"], note: "install channel (becomes a subcommand)" },
  { argv: ["install", "latest", "--force"], note: "install latest force (becomes a subcommand)" },
  { argv: ["install", "1.2.3"], note: "install version (becomes a subcommand)" },
  { argv: ["install", "--force"], note: "install force (becomes a subcommand)" },
  { argv: ["install", "--help"], note: "install help (becomes a subcommand)" },
  { argv: ["install", "--self", "--manifest", "m", "--signature", "s"], note: "install self (becomes a subcommand)" },
  { argv: ["update"], note: "bare update (becomes a subcommand)" },
  { argv: ["update", "-h"], note: "update help (becomes a subcommand)" },
  { argv: ["update", "--background"], note: "background update (becomes a subcommand)" },
  { argv: ["upgrade"], note: "bare upgrade (becomes a subcommand)" },
  { argv: ["rollback"], note: "bare rollback (becomes a subcommand)" },
  { argv: ["update", "the", "readme"], note: "prompt starting with update" },
  { argv: ["update", "-p"], note: "print mode with prompt update" },
  { argv: ["-p", "install"], note: "print mode with prompt install" },
  { argv: ["install", "foo"], note: "prompt install foo" },
  { argv: ["install", "1.2"], note: "prompt install 1.2 (not a version)" },
  { argv: ["install", "stable", "now"], note: "prompt install stable now" },
  { argv: ["rollback", "now"], note: "prompt rollback now" },
  { argv: ["install", "--force", "--bogus"], note: "subcommand word with unknown flag" },
  { argv: ["update", "--background", "-p"], note: "update background with print" },
];

export type ParseOutcome = { ok: true; options: CliOptions } | { ok: false; error: string };

export function parseOutcome(argv: string[]): ParseOutcome {
  try {
    return { ok: true, options: parseCli(argv) };
  } catch (e) {
    if (e instanceof CliError) return { ok: false, error: e.message };
    throw e;
  }
}
