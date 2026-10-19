// src/cli/args.ts
import { parseArgs } from "node:util";
import { EFFORTS, MODES, OUTPUT_FORMATS, type Effort, type Mode, type OutputFormat } from "../config/constants";
import { isVersion } from "../install/version";
import { isLifecycleName, type LifecycleName } from "./lifecycle/names";

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
  /** `tcode gateway`: run as the always-on gateway instead of a session. */
  gateway?: GatewayOptions;
}

export interface GatewayOptions {
  /** The project directory chats work in (default: the current one). */
  workspace?: string;
  /** Serve the local web UI too (default); --no-web turns it off. */
  web: boolean;
  /** `--dev`: the dashboard also accepts the Vite dev server's origin (http://localhost:5173). */
  dev: boolean;
}

/** `tcode gateway [--workspace <dir>] [--no-web]`: the gateway flags, then the usual parser. */
export function parseGateway(argv: string[]): CliOptions {
  const rest: string[] = [];
  const gateway: GatewayOptions = { web: true, dev: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-web") gateway.web = false;
    else if (arg === "--dev") gateway.dev = true;
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
  | { kind: "gateway-start" }
  | { kind: "gateway-stop" }
  | { kind: "gateway-restart" }
  | { kind: "projects-list" }
  | { kind: "projects-add"; path: string; name?: string }
  | { kind: "projects-remove"; id: string }
  | { kind: "projects-default"; id: string }
  | { kind: "projects-share"; id: string; shared: boolean }
  | { kind: "pairing-approve"; channel: string; code: string }
  | { kind: "pairing-list" }
  | { kind: "pairing-revoke"; channel: string; senderId: string }
  | { kind: "help"; command: "gateway" | "pairing" | "projects" };

const GATEWAY_USAGE = "usage: tcode gateway [install [--workspace <dir>] | uninstall | start | stop | restart]";
const PROJECTS_USAGE = "usage: tcode projects [list | add <path> [--name <name>] | remove <id> | default <id> | share <id> | unshare <id>]";

/** `tcode gateway install|uninstall|start|stop|restart`, `tcode projects …` and `tcode pairing …`; null for anything else. */
export function matchGatewayCommand(argv: string[]): GatewayCommand | null {
  const [word, sub, ...rest] = argv;
  if (word === "gateway") {
    if (sub === "-h" || sub === "--help") return { kind: "help", command: "gateway" };
    const bare: Record<string, GatewayCommand> = {
      uninstall: { kind: "gateway-uninstall" },
      start: { kind: "gateway-start" },
      stop: { kind: "gateway-stop" },
      restart: { kind: "gateway-restart" },
    };
    if (sub !== undefined && Object.hasOwn(bare, sub)) {
      if (rest.length === 0) return bare[sub]!;
      throw new CliError(GATEWAY_USAGE);
    }
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
  if (word === "projects") {
    if (sub === "-h" || sub === "--help") return { kind: "help", command: "projects" };
    if (sub === undefined || (sub === "list" && rest.length === 0)) return { kind: "projects-list" };
    if (sub === "remove" && rest.length === 1) return { kind: "projects-remove", id: rest[0]! };
    if (sub === "default" && rest.length === 1) return { kind: "projects-default", id: rest[0]! };
    if ((sub === "share" || sub === "unshare") && rest.length === 1) return { kind: "projects-share", id: rest[0]!, shared: sub === "share" };
    if (sub === "add") {
      let path: string | undefined;
      let name: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === "--name" || arg.startsWith("--name=")) {
          const value = arg === "--name" ? rest[++i] : arg.slice("--name=".length);
          if (!value || name !== undefined) throw new CliError(PROJECTS_USAGE);
          name = value;
        } else if (path === undefined && !arg.startsWith("-")) path = arg;
        else throw new CliError(PROJECTS_USAGE);
      }
      if (path === undefined) throw new CliError(PROJECTS_USAGE);
      return { kind: "projects-add", path, ...(name !== undefined ? { name } : {}) };
    }
    throw new CliError(PROJECTS_USAGE);
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
  | { kind: "lifecycle"; name: LifecycleName; argv: string[]; /** Printed to stderr before the command runs (a retired spelling). */ notice?: string }
  | { kind: "session"; options: CliOptions };

const SUBCOMMAND_WORDS = new Set(["install", "update", "upgrade", "rollback"]);

/** A subcommand only when the whole argv has one of these exact shapes. */
export function matchSubcommand(argv: string[]): InstallCommand | null {
  const [word, ...rest] = argv;
  if (!word || !SUBCOMMAND_WORDS.has(word)) return null;
  const command = word as "install" | "update" | "upgrade" | "rollback";
  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) return { kind: "help", command };
  if (command === "rollback") return rest.length === 0 ? { kind: "rollback" } : null;
  if (command === "update" || command === "upgrade") {
    // `tcode update --version <v>` installs that release (the old `tcode install <v>` without the extra word).
    const pinned = rest.length === 2 && rest[0] === "--version" ? rest[1] : rest.length === 1 && rest[0]!.startsWith("--version=") ? rest[0]!.slice("--version=".length) : undefined;
    if (pinned !== undefined) return isVersion(pinned) ? { kind: "install", target: pinned, force: false } : null;
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

/** `tcode gateway logs [-n N | --lines N | --lines=N]` as the arguments of `tcode logs gateway`. */
function gatewayLogsArgs(rest: string[]): string[] {
  if (rest.length === 0) return [];
  const raw = rest.length === 2 && (rest[0] === "-n" || rest[0] === "--lines") ? rest[1] : rest.length === 1 && rest[0]!.startsWith("--lines=") ? rest[0]!.slice("--lines=".length) : undefined;
  const lines = Number(raw);
  if (raw === undefined || !Number.isInteger(lines) || lines < 1) throw new CliError("usage: tcode logs gateway [-n <lines>]");
  return ["-n", String(lines)];
}

/** Subcommands first (unless argv starts with "--"), otherwise exactly the old parser. */
export function parseInvocation(argv: string[]): Invocation {
  if (argv[0] !== "--") {
    const command = matchSubcommand(argv);
    if (command) return { kind: "subcommand", command };
    // `tcode web` is retired: the dashboard is the one way to open the web UI.
    if (argv[0] === "web") return { kind: "lifecycle", name: "dashboard", argv: argv.slice(1), notice: "tcode web is now tcode dashboard." };
    if (argv[0] === "gateway" && argv[1] === "status" && argv.length === 2) return { kind: "lifecycle", name: "status", argv: [] };
    if (argv[0] === "gateway" && argv[1] === "logs") return { kind: "lifecycle", name: "logs", argv: ["gateway", ...gatewayLogsArgs(argv.slice(2))] };
    if (isLifecycleName(argv[0])) return { kind: "lifecycle", name: argv[0], argv: argv.slice(1) };
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
