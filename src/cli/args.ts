// src/cli/args.ts
import { parseArgs } from "node:util";
import { EFFORTS, MODES, OUTPUT_FORMATS, type Effort, type Mode, type OutputFormat } from "../config/constants";

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
