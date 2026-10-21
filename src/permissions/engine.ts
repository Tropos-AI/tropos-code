// src/permissions/engine.ts
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Mode, ToolKind } from "../config/constants";
import type { Autonomy } from "../gateway/config";
import { isTestManifest, matchesTestCommand } from "../gateway/tests-detect";
import type { SessionRole } from "../gateway/types";
import { STORE_TOOLS } from "../learning/stores";
import { isInside } from "../paths";
import { resolveToolPath } from "../tools/paths";
import { isReadOnlyCommand, pathsStayInside } from "./readonly";
import {
  bashPatternMatches,
  createRestrictBudget,
  foldName,
  formatRule,
  hasLeadingPrefix,
  isCodeRunner,
  parseRule,
  pathPatternMatches,
  splitBashCommand,
  squashShellSpace,
  type RestrictBudget,
  type Rule,
} from "./rules";

export interface PermissionRequest {
  toolName: string;
  kind: ToolKind;
  command?: string;
  paths: string[];
  /** Matched by rule patterns for tools without paths or a command (WebFetch domains, skill names). */
  target?: string;
  /** Can't be fully undone, so never a store save (src/tools/types.ts PermissionSubject). */
  destructive?: boolean;
  /** Where a command runs (the shell's working directory); the project when unset. */
  cwd?: string;
  /** A reason to ask even when a rule or the autonomy level would allow (src/tools/types.ts PermissionSubject). */
  askReason?: string;
}

export interface PermissionRules {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
}

/** How freely a chat's agent acts without asking (src/gateway/autonomy.ts), and the test commands it may run at `balanced`. */
export interface AutonomyPolicy {
  level: Autonomy;
  testCommands: readonly string[];
}

export interface PermissionContext {
  mode: Mode;
  rules: PermissionRules;
  cwd: string;
  /** The user's home, for `~` in rules and commands. Never Tropos's home: its stores arrive in `stores`. */
  home: string;
  allowedDirs: string[];
  /** Paths outside allowedDirs are denied, not asked about: sessions started from a messaging channel. */
  confine?: boolean;
  /** Who the session answers to; only the owner's saves to Tropos's stores skip the prompt. */
  role?: SessionRole;
  /** Tropos's own stores (canonical paths, src/learning/stores.ts) and whether saving there still asks. */
  stores?: { paths: string[]; askBeforeSaving: boolean };
  /** Unset outside the gateway: everything asks as before. */
  autonomy?: AutonomyPolicy;
  /** The chief's own files inside the default project (workspaceOwnPaths): only the store tools may use them. */
  ownFiles?: string[];
  /** Instruction files at the default project's root (workspaceInstructionPaths): only the owner may write them. */
  instructionFiles?: string[];
}

export type Decision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; reason?: string; suggestion?: string };

export const PLAN_MODE_REASON =
  "Plan mode is on, so only read-only tools may run. Finish researching and present your plan instead.";

export function compileRules(cfg: { allow: string[]; ask: string[]; deny: string[] }): {
  rules: PermissionRules;
  invalid: string[];
} {
  const invalid: string[] = [];
  const compile = (list: string[]) =>
    list.flatMap((text) => {
      try {
        return [parseRule(text)];
      } catch {
        invalid.push(text);
        return [];
      }
    });
  return { rules: { allow: compile(cfg.allow), ask: compile(cfg.ask), deny: compile(cfg.deny) }, invalid };
}

/** `mcp__github` covers every tool of that server; `mcp__github__*` (any name ending in `*`) is a prefix. */
function toolNameMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true;
  if (ruleTool.endsWith("*")) return toolName.startsWith(ruleTool.slice(0, -1));
  return /^mcp__[^_]/.test(ruleTool) && !ruleTool.slice(5).includes("__") && toolName.startsWith(`${ruleTool}__`);
}

/** Glob match of a rule pattern against a target: `*` matches anything; case-insensitive (domains, names). */
export function targetPatternMatches(pattern: string, target: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "is");
  return re.test(target);
}

function toolMatches(rule: Rule, req: PermissionRequest): boolean {
  if (toolNameMatches(rule.tool, req.toolName)) return true;
  if (rule.tool === "Edit" && req.kind === "edit") return true;
  if (rule.tool === "Read" && req.kind === "read") return true;
  return false;
}

/**
 * Does the rule match this request? `mode` "any" = some path/command part hits; "all" = every one does.
 * `restrict` = deny/ask matching (broad: case-insensitive where the filesystem is, wrapper-insensitive
 * for commands, relative patterns may climb out of cwd); allow matching is always narrow.
 */
function ruleHits(
  rule: Rule,
  req: PermissionRequest,
  ctx: PermissionContext,
  mode: "any" | "all",
  restrict = false,
  budget?: RestrictBudget,
): boolean {
  if (!toolMatches(rule, req)) return false;
  if (!rule.pattern) {
    // A bare allow rule for a command tool is `Bash(*)`: it never approves a code runner.
    if (!restrict && req.command !== undefined) return bashPatternMatches("*", req.command);
    return true;
  }
  if (req.command !== undefined) {
    const { parts } = splitBashCommand(req.command);
    const hit = (p: string) => bashPatternMatches(rule.pattern!, p, { restrict, budget });
    return mode === "any" ? parts.some(hit) : parts.length > 0 && parts.every(hit);
  }
  if (req.target !== undefined) return targetPatternMatches(rule.pattern, req.target);
  // A tool that acts with nothing a pattern could match (an MCP tool): a deny or ask rule naming it
  // still applies, so `mcp__github__delete_repo(*)` can't silently miss; an allow rule must be bare.
  // Read tools without paths keep the old reading: a path rule says nothing about them.
  if (req.paths.length === 0) return restrict && (req.kind === "exec" || req.kind === "net") && toolNameMatches(rule.tool, req.toolName);
  const hit = (p: string) => pathPatternMatches(rule.pattern!, p, ctx.cwd, ctx.home, { restrict });
  return mode === "any" ? req.paths.some(hit) : req.paths.every(hit);
}

function isAllowed(req: PermissionRequest, ctx: PermissionContext): boolean {
  if (req.command !== undefined) {
    const { parts, unsafe } = splitBashCommand(req.command);
    if (unsafe || parts.length === 0) return false;
    // Every simple command must be covered by some allow rule.
    return parts.every((part) =>
      ctx.rules.allow.some((rule) => ruleHits(rule, { ...req, command: part }, ctx, "all")),
    );
  }
  // A bare rule (`Read`) is not a path scope: it never approves a path outside the project.
  const inside = req.paths.every((p) => ctx.allowedDirs.some((dir) => isInside(p, dir)));
  // Writes inside .git/.husky run code on a later git command: only a rule whose pattern names
  // the folder (`Edit(.husky/**)`) approves them, never a broad one like `Edit(**)`.
  const gitControl = req.kind === "edit" && req.paths.some((p) => inGitControlDir(p));
  return ctx.rules.allow.some(
    (rule) =>
      (rule.pattern !== undefined || inside) &&
      (!gitControl || (rule.pattern !== undefined && inGitControlDir(rule.pattern))) &&
      ruleHits(rule, req, ctx, "all"),
  );
}

const STORE_TOOL_NAMES: ReadonlySet<string> = new Set(STORE_TOOLS);

/**
 * True when a store tool saves only inside Tropos's stores. Each path is resolved again on disk, so a link inside a
 * store that points elsewhere doesn't count; a path that won't resolve doesn't either. A destructive action (a skill
 * delete, whose supporting files the ledger can't bring back) is not a save: it keeps asking.
 */
export function isStoreSave(req: PermissionRequest, ctx: PermissionContext): boolean {
  if (!STORE_TOOL_NAMES.has(req.toolName) || req.destructive || req.paths.length === 0 || !ctx.stores) return false;
  const stores = ctx.stores.paths;
  return req.paths.every((p) => {
    let real: string;
    try {
      real = resolveToolPath(p, "/");
    } catch {
      return false;
    }
    return stores.some((dir) => isInside(real, dir));
  });
}

/**
 * What the chat's autonomy level lets run unasked; checked only after deny, confinement, plan mode and ask rules.
 * Store tools keep their own rule (only the owner's saves skip the prompt), MCP and other exec tools always ask.
 */
function autonomyAllows(req: PermissionRequest, ctx: PermissionContext): boolean {
  const policy = ctx.autonomy;
  if (!policy || policy.level === "ask" || STORE_TOOL_NAMES.has(req.toolName)) return false;
  if (req.kind === "edit") {
    if (req.paths.length === 0) return false;
    return req.paths.every(
      (p) =>
        ctx.allowedDirs.some((dir) => isInside(p, dir)) &&
        // Hooks and config under .git/.husky run code on a later git command, hooks in Tropos's settings on the
        // next session: they ask at every level.
        !inGitControlDir(p) &&
        !isProjectSettingsFile(p) &&
        // A test manifest decides what a pinned test command runs.
        (policy.level === "autonomous" || !isTestManifest(p)),
    );
  }
  if (req.toolName !== "Bash" || req.command === undefined) return false;
  // Writes Bash makes to .git/.husky or outside the project are stopped by the confinement profile instead.
  if (policy.level === "autonomous") return true;
  const { parts, unsafe } = splitBashCommand(req.command);
  if (unsafe || parts.length === 0) return false;
  // Pinned tests are matched against the project, so a test path must exist inside it.
  const known = parts.every((part) => isReadOnlyCommand(part) || matchesTestCommand(part, policy.testCommands, ctx.cwd));
  // Relative words resolve from where the shell is; pathsStayInside refuses a base outside the project.
  return known && pathsStayInside(req.command, req.cwd ?? ctx.cwd, ctx.home, ctx.allowedDirs);
}

/** Folded the way the disk compares names, so `user.md` can't slip past a guard on `USER.md` on macOS/Windows. */
function foldPath(path: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
}

/** The first of the request's paths that lies in one of the chief's own files. */
export function ownFilePath(req: PermissionRequest, ctx: PermissionContext): string | undefined {
  if (!ctx.ownFiles?.length || STORE_TOOL_NAMES.has(req.toolName)) return undefined;
  const own = ctx.ownFiles.map(foldPath);
  return req.paths.find((p) => own.some((dir) => isInside(foldPath(p), dir)));
}

/** A path with its links resolved: the whole path where it exists, else its real parent and its own name. */
function realForm(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/** The first of an edit's paths that is one of the workspace's instruction files, as written or through a link. */
function instructionFilePath(req: PermissionRequest, ctx: PermissionContext): string | undefined {
  if (req.kind !== "edit" || !ctx.instructionFiles?.length) return undefined;
  const files = new Set(ctx.instructionFiles.flatMap((f) => [foldPath(f), foldPath(realForm(f))]));
  return req.paths.find((p) => files.has(foldPath(p)) || files.has(foldPath(realForm(p))));
}

export function decide(req: PermissionRequest, ctx: PermissionContext): Decision {
  // One work allowance covers every deny and ask rule, so many rules cannot multiply the cost.
  const budget = createRestrictBudget();
  const denied = ctx.rules.deny.find((rule) => ruleHits(rule, req, ctx, "any", true, budget));
  if (denied) return { behavior: "deny", reason: `Blocked by the deny rule ${formatRule(denied)}.` };
  // The chief's files sit in the default project: generic file tools stay away from them in confined and non-owner
  // sessions, and the owner is asked (below). The store tools keep their own path.
  const own = ownFilePath(req, ctx);
  if (own && (ctx.confine || ctx.role !== "owner")) {
    return { behavior: "deny", reason: `${own} is Tropos's own memory; only its memory tools may use it in this session.` };
  }
  // The owner's sessions in the default project load these; nobody else may plant text in them.
  const instruction = ctx.role !== "owner" ? instructionFilePath(req, ctx) : undefined;
  if (instruction) return { behavior: "deny", reason: `${instruction} holds instructions for the owner's sessions; only the owner may change it.` };
  // The owner's own notes, skills and identity live under the Tropos home, outside any workspace.
  const ownerStoreSave = ctx.role === "owner" && isStoreSave(req, ctx);
  if (ctx.confine && !ownerStoreSave) {
    const outside = req.paths.find((p) => !ctx.allowedDirs.some((dir) => isInside(p, dir)));
    if (outside) return { behavior: "deny", reason: `This session is confined to the workspace; ${outside} is outside it.` };
  }
  if (ctx.mode === "bypass") return { behavior: "allow" };
  if (ctx.mode === "plan" && (req.kind === "edit" || req.kind === "exec")) {
    return { behavior: "deny", reason: PLAN_MODE_REASON };
  }
  // Ahead of every allow path (rules, accept-edits, autonomy): a broad `Edit(**)` never approves these silently.
  if (own) return { behavior: "ask", reason: `Tropos's own file: ${own}` };
  if (ctx.rules.ask.some((rule) => ruleHits(rule, req, ctx, "any", true, budget))) return { behavior: "ask" };
  // The tool itself says this call needs the owner's eye (a burst of texts to one person), allow rules or not.
  if (req.askReason) return { behavior: "ask", reason: req.askReason };
  // Removing an MCP server or a plugin, or replacing a file: no allow rule or autonomy level does that unasked, and no
  // "don't ask again" rule is offered for it.
  if (req.destructive && req.kind === "exec") return { behavior: "ask", reason: "This can't be undone." };
  // Asking hooks still turn this allow into a prompt (src/agent/agent.ts).
  if (ownerStoreSave && !ctx.stores!.askBeforeSaving) return { behavior: "allow" };
  if (autonomyAllows(req, ctx)) return { behavior: "allow" };
  if (isAllowed(req, ctx)) return { behavior: "allow" };

  const outside = req.paths.find((p) => !ctx.allowedDirs.some((dir) => isInside(p, dir)));
  if (outside) return { behavior: "ask", reason: `outside the project: ${outside}` };

  if (req.kind === "read" || req.kind === "meta") return { behavior: "allow" };
  const suggestion = suggestRule(req, ctx.cwd);
  if (req.kind === "edit" && ctx.mode === "acceptEdits") {
    if (!req.paths.some((p) => inGitControlDir(p))) return { behavior: "allow" };
    // Hooks and config under .git/.husky run code on a later git command: never auto-approved.
    const reason = "writes to git hooks/config run code later";
    return suggestion ? { behavior: "ask", reason, suggestion } : { behavior: "ask", reason };
  }
  return suggestion ? { behavior: "ask", suggestion } : { behavior: "ask" };
}

const GIT_CONTROL_NAMES = new Set([".git", ".husky"]);
/** 8.3 short names NTFS gives `.git` and `.husky`. */
const NTFS_SHORT_NAMES = new Set(["git~1", "husky~1"]);

/**
 * True when any segment of the path names `.git` or `.husky` on this platform: folded the way
 * APFS and NTFS compare names, and on win32 also with NTFS's trailing dots and spaces, alternate
 * stream suffix (`.git::$INDEX_ALLOCATION`) and 8.3 short names (`GIT~1`).
 */
export function inGitControlDir(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const insensitive = platform === "darwin" || platform === "win32";
  const segments = platform === "win32" ? path.split(/[\\/]/) : path.split("/");
  return segments.some((segment) => {
    let name = foldName(segment, insensitive);
    if (platform === "win32") {
      name = name.replace(/:.*$/s, "").replace(/[. ]+$/, "");
      if (NTFS_SHORT_NAMES.has(name)) return true;
    }
    return GIT_CONTROL_NAMES.has(name);
  });
}

const SETTINGS_FILES = new Set(["settings.json", "settings.local.json"]);

/** `.tropos/settings.json` or `.tropos/settings.local.json` at any depth (src/config/settings.ts), folded like inGitControlDir. */
export function isProjectSettingsFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const insensitive = platform === "darwin" || platform === "win32";
  const segments = (platform === "win32" ? path.split(/[\\/]/) : path.split("/")).map((segment) => {
    const name = foldName(segment, insensitive);
    return platform === "win32" ? name.replace(/:.*$/s, "").replace(/[. ]+$/, "") : name;
  });
  return segments.length >= 2 && SETTINGS_FILES.has(segments.at(-1)!) && segments.at(-2) === ".tropos";
}

const SHELL_SPACE = /[ \t\n]+/;

function commandPrefix(command: string): string {
  const words = squashShellSpace(command).split(" ");
  const prefix = [words[0]!];
  const second = words[1];
  if (second && /^[a-z][a-z0-9-]*$/.test(second)) prefix.push(second);
  return prefix.join(" ");
}

/** The rule offered by "Yes, and don't ask again", or undefined when no safe rule exists. */
export function suggestRule(req: PermissionRequest, cwd: string): string | undefined {
  if (req.command !== undefined) {
    const { parts, unsafe } = splitBashCommand(req.command);
    if (unsafe || parts.length !== 1) return undefined;
    const part = parts[0]!;
    // A prefix rule cannot describe a command that starts with assignments, redirects or a wrapper.
    if (hasLeadingPrefix(part)) return undefined;
    const [word = "", second = ""] = part.split(SHELL_SPACE);
    if (isCodeRunner(word) || second.startsWith("-")) {
      // Interpreters run arbitrary code, and a leading option (`git -c core.pager=...`) can change
      // what the subcommand does: only ever offer the exact command.
      const exact = squashShellSpace(part);
      return exact.length > 200 || exact.endsWith(":*") ? undefined : `${req.toolName}(${exact})`;
    }
    return `${req.toolName}(${commandPrefix(part)}:*)`;
  }
  // A target with "*" would suggest a wildcard rule; parentheses would end the rule early.
  if (req.target !== undefined) return /[*()]/.test(req.target) ? undefined : `${req.toolName}(${req.target})`;
  if (req.kind === "exec" && req.paths.length === 0) return req.toolName;
  if (req.kind === "edit" && req.paths.length > 0) {
    const dir = dirname(req.paths[0]!);
    if (!isInside(dir, cwd)) return undefined;
    const rel = relative(cwd, dir);
    // A folder named "*" or "[a-z]" would turn into a glob covering far more than was approved.
    if (/[*?[\]{}()!]/.test(rel)) return undefined;
    return `Edit(${rel ? `${rel}/` : ""}**)`;
  }
  return undefined;
}
