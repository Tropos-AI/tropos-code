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
  /** `tcode web`: serve the browser UI instead of the terminal one. */
  web?: WebOptions;
  /** `tcode gateway`: run as the always-on gateway instead of a session. */
  gateway?: GatewayOptions;
}

export interface GatewayOptions {
  /** The project directory chats work in (default: the current one). */
  workspace?: string;
  /** Serve the local web UI too (default); --no-web turns it off. */
  web: boolean;
}

/** `tcode gateway [--workspace <dir>] [--no-web]`: the gateway flags, then the usual parser. */
export function parseGateway(argv: string[]): CliOptions {
  const rest: string[] = [];
  const gateway: GatewayOptions = { web: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-web") gateway.web = false;
    else if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const raw = arg === "--workspace" ? argv[++i] : arg.slice("--workspace=".length);
      if (!raw) throw new CliError("--workspace needs a directory");
      gateway.workspace = raw;
    } else rest.push(arg);
  }
  const options = parseCli(rest);
  if (options.print) throw new CliError("tcode gateway runs until stopped; -p (print mode) doesn't apply");
  if (options.prompt) throw new CliError(`tcode gateway takes no prompt (got "${options.prompt}")`);
  return { ...options, gateway };
}

export type GatewayCommand =
  | { kind: "gateway-install"; workspace?: string }
  | { kind: "gateway-uninstall" }
  | { kind: "gateway-status" }
  | { kind: "pairing-approve"; channel: string; code: string }
  | { kind: "pairing-list" }
  | { kind: "pairing-revoke"; channel: string; senderId: string }
  | { kind: "help"; command: "gateway" | "pairing" };

/** `tcode gateway install|uninstall|status` and `tcode pairing approve|list|revoke`; null for anything else. */
export function matchGatewayCommand(argv: string[]): GatewayCommand | null {
  const [word, sub, ...rest] = argv;
  if (word === "gateway") {
    if (sub === "-h" || sub === "--help") return { kind: "help", command: "gateway" };
    if (sub === "uninstall" && rest.length === 0) return { kind: "gateway-uninstall" };
    if (sub === "status" && rest.length === 0) return { kind: "gateway-status" };
    if (sub === "install") {
      if (rest.length === 0) return { kind: "gateway-install" };
      if (rest[0] === "--workspace" && rest[1] && rest.length === 2) return { kind: "gateway-install", workspace: rest[1] };
      if (rest.length === 1 && rest[0]!.startsWith("--workspace=") && rest[0]!.length > "--workspace=".length) {
        return { kind: "gateway-install", workspace: rest[0]!.slice("--workspace=".length) };
      }
      throw new CliError("usage: tcode gateway install [--workspace <dir>]");
    }
    return null;
  }
  if (word === "pairing") {
    if (sub === undefined || sub === "-h" || sub === "--help") return { kind: "help", command: "pairing" };
    if (sub === "list" && rest.length === 0) return { kind: "pairing-list" };
    if (sub === "approve" && rest.length === 2) return { kind: "pairing-approve", channel: rest[0]!, code: rest[1]! };
    if (sub === "revoke" && rest.length === 2) return { kind: "pairing-revoke", channel: rest[0]!, senderId: rest[1]! };
    throw new CliError("usage: tcode pairing approve <channel> <code> | list | revoke <channel> <sender-id>");
  }
  return null;
}

export interface WebOptions {
  port?: number;
  /** Open the browser (default); --no-open only prints the link. */
  open: boolean;
  /** Accept the Vite dev server's origin too (`bun run dev:web`). */
  dev: boolean;
}

/** `tcode web [--port <n>] [--no-open] [--dev] [session options]`: the web flags, then the usual parser. */
export function parseWeb(argv: string[]): CliOptions {
  const rest: string[] = [];
  const web: WebOptions = { open: true, dev: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-open") web.open = false;
    else if (arg === "--dev") web.dev = true;
    else if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = arg === "--port" ? argv[++i] : arg.slice("--port=".length);
      const port = Number(raw);
      // 0 asks the system for any free port.
      if (raw === undefined || raw === "" || !Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`--port must be a port number (got "${raw ?? ""}")`);
      web.port = port;
    } else rest.push(arg);
  }
  const options = parseCli(rest);
  if (options.print) throw new CliError("tcode web serves the browser UI; -p (print mode) doesn't apply");
  if (options.prompt) throw new CliError(`tcode web takes no prompt (got "${options.prompt}"); type it in the browser`);
  return { ...options, web };
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

export type Invocation =
  | { kind: "subcommand"; command: InstallCommand }
  | { kind: "gateway-command"; command: GatewayCommand }
  | { kind: "session"; options: CliOptions };

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
    if (argv[0] === "web") return { kind: "session", options: parseWeb(argv.slice(1)) };
    const gatewayCommand = matchGatewayCommand(argv);
    if (gatewayCommand) return { kind: "gateway-command", command: gatewayCommand };
    if (argv[0] === "gateway") return { kind: "session", options: parseGateway(argv.slice(1)) };
  }
  try {
    return { kind: "session", options: parseCli(argv) };
  } catch (e) {
    const word = argv[0];
    if (e instanceof CliError && word && SUBCOMMAND_WORDS.has(word)) throw new CliError(`${e.message}\nFor ${word}, see tcode ${word} --help.`);
    throw e;
  }
}
