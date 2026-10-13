// src/cli/args.ts
import { parseArgs } from "node:util";
import { EFFORTS, MODES, OUTPUT_FORMATS, type Effort, type Mode, type OutputFormat } from "../config/constants";
import { isVersion } from "../install/version";

export interface CliOptions {
  prompt?: string;
  print: boolean;
  outputFormat: OutputFormat;
  maxTurns?: number;
  allowedTools: string[];
  model?: string;
  effort?: Effort;
  continue: boolean;
  resume: boolean;
  resumeId?: string;
  permissionMode?: Mode;
  dangerouslySkipPermissions: boolean;
  addDir: string[];
  help: boolean;
  version: boolean;
}

export class CliError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits "A,B(x,y),C" on commas that are not inside (), {} or []. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(`--${name} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

export function parseCli(argv: string[]): CliOptions {
  const args = [...argv];
  let resumeId: string | undefined;
  const resumeAt = args.findIndex((a) => a === "-r" || a === "--resume");
  const maybeId = resumeAt === -1 ? undefined : args[resumeAt + 1];
  if (maybeId && UUID_RE.test(maybeId)) {
    resumeId = maybeId;
    args.splice(resumeAt + 1, 1);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        print: { type: "boolean", short: "p", default: false },
        "output-format": { type: "string", default: "text" },
        "max-turns": { type: "string" },
        "allowed-tools": { type: "string", multiple: true, default: [] },
        model: { type: "string" },
        effort: { type: "string" },
        continue: { type: "boolean", short: "c", default: false },
        resume: { type: "boolean", short: "r", default: false },
        "permission-mode": { type: "string" },
        "dangerously-skip-permissions": { type: "boolean", default: false },
        "add-dir": { type: "string", multiple: true, default: [] },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  const v = parsed.values;

  let maxTurns: number | undefined;
  if (v["max-turns"] !== undefined) {
    maxTurns = Number(v["max-turns"]);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new CliError(`--max-turns must be a positive integer (got "${v["max-turns"]}")`);
    }
  }

  const permissionMode = oneOf("permission-mode", v["permission-mode"], MODES);
  if (permissionMode === "bypass") {
    throw new CliError("use --dangerously-skip-permissions to bypass permission checks");
  }
  if (v.continue && v.resume) throw new CliError("--continue and --resume cannot be combined");

  const prompt = parsed.positionals.join(" ").trim();
  return {
    prompt: prompt.length > 0 ? prompt : undefined,
    print: v.print ?? false,
    outputFormat: oneOf("output-format", v["output-format"], OUTPUT_FORMATS) ?? "text",
    maxTurns,
    allowedTools: (v["allowed-tools"] ?? []).flatMap(splitTopLevel),
    model: v.model,
    effort: oneOf("effort", v.effort, EFFORTS),
    continue: v.continue ?? false,
    resume: v.resume ?? false,
    resumeId,
    permissionMode,
    dangerouslySkipPermissions: v["dangerously-skip-permissions"] ?? false,
    addDir: v["add-dir"] ?? [],
    help: v.help ?? false,
    version: v.version ?? false,
  };
}

export type InstallCommand =
  | { kind: "install"; target?: string; force: boolean }
  | { kind: "install-self"; manifest: string; signature: string }
  | { kind: "update"; background: boolean; alias: "update" | "upgrade" }
  | { kind: "rollback" }
  | { kind: "help"; command: "install" | "update" | "upgrade" | "rollback" };

export type Invocation = { kind: "subcommand"; command: InstallCommand } | { kind: "session"; options: CliOptions };

const SUBCOMMAND_WORDS = new Set(["install", "update", "upgrade", "rollback"]);

/** Spec §12.2: a subcommand only when the whole argv has one of these exact shapes. */
export function matchSubcommand(argv: string[]): InstallCommand | null {
  const [word, ...rest] = argv;
  if (!word || !SUBCOMMAND_WORDS.has(word)) return null;
  const command = word as "install" | "update" | "upgrade" | "rollback";
  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) return { kind: "help", command };
  if (command === "rollback") return rest.length === 0 ? { kind: "rollback" } : null;
  if (command === "update" || command === "upgrade") {
    if (rest.length === 0) return { kind: "update", background: false, alias: command };
    if (rest.length === 1 && rest[0] === "--background") return { kind: "update", background: true, alias: command };
    return null;
  }
  if (rest.length === 5 && rest[0] === "--self" && rest[1] === "--manifest" && rest[3] === "--signature" && rest[2] && rest[4]) {
    return { kind: "install-self", manifest: rest[2], signature: rest[4] };
  }
  let target: string | undefined;
  let force = false;
  for (const arg of rest) {
    if (arg === "--force" && !force) force = true;
    else if (target === undefined && (arg === "stable" || arg === "latest" || isVersion(arg))) target = arg;
    else return null;
  }
  return { kind: "install", target, force };
}

/** Subcommands first (unless argv starts with "--", amendment A2), otherwise exactly the old parser. */
export function parseInvocation(argv: string[]): Invocation {
  if (argv[0] !== "--") {
    const command = matchSubcommand(argv);
    if (command) return { kind: "subcommand", command };
  }
  try {
    return { kind: "session", options: parseCli(argv) };
  } catch (e) {
    const word = argv[0];
    if (e instanceof CliError && word && SUBCOMMAND_WORDS.has(word)) throw new CliError(`${e.message}\nFor ${word}, see tropos ${word} --help.`);
    throw e;
  }
}
