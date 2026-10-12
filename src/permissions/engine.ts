// src/permissions/engine.ts
import { dirname, relative } from "node:path";
import type { Mode, ToolKind } from "../config/constants";
import { isInside } from "../paths";
import { bashPatternMatches, formatRule, parseRule, pathPatternMatches, splitBashCommand, type Rule } from "./rules";

export interface PermissionRequest {
  toolName: string;
  kind: ToolKind;
  command?: string;
  paths: string[];
}

export interface PermissionRules {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
}

export interface PermissionContext {
  mode: Mode;
  rules: PermissionRules;
  cwd: string;
  home: string;
  allowedDirs: string[];
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

function toolMatches(rule: Rule, req: PermissionRequest): boolean {
  if (rule.tool === req.toolName) return true;
  if (rule.tool === "Edit" && req.kind === "edit") return true;
  if (rule.tool === "Read" && req.kind === "read") return true;
  return false;
}

/**
 * Does the rule match this request? `mode` "any" = some path/command part hits; "all" = every one does.
 * `restrict` = deny/ask matching (broad: case-insensitive where the filesystem is, wrapper-insensitive
 * for commands, relative patterns may climb out of cwd); allow matching is always narrow.
 */
function ruleHits(rule: Rule, req: PermissionRequest, ctx: PermissionContext, mode: "any" | "all", restrict = false): boolean {
  if (!toolMatches(rule, req)) return false;
  if (!rule.pattern) return true;
  if (req.command !== undefined) {
    const { parts } = splitBashCommand(req.command);
    const hit = (p: string) => bashPatternMatches(rule.pattern!, p, { restrict });
    return mode === "any" ? parts.some(hit) : parts.length > 0 && parts.every(hit);
  }
  if (req.paths.length === 0) return false;
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
  return ctx.rules.allow.some((rule) => ruleHits(rule, req, ctx, "all"));
}

export function decide(req: PermissionRequest, ctx: PermissionContext): Decision {
  const denied = ctx.rules.deny.find((rule) => ruleHits(rule, req, ctx, "any", true));
  if (denied) return { behavior: "deny", reason: `Blocked by the deny rule ${formatRule(denied)}.` };
  if (ctx.mode === "bypass") return { behavior: "allow" };
  if (ctx.mode === "plan" && (req.kind === "edit" || req.kind === "exec")) {
    return { behavior: "deny", reason: PLAN_MODE_REASON };
  }
  if (ctx.rules.ask.some((rule) => ruleHits(rule, req, ctx, "any", true))) return { behavior: "ask" };
  if (isAllowed(req, ctx)) return { behavior: "allow" };

  const outside = req.paths.find((p) => !ctx.allowedDirs.some((dir) => isInside(p, dir)));
  if (outside) return { behavior: "ask", reason: `outside the project: ${outside}` };

  if (req.kind === "read" || req.kind === "meta") return { behavior: "allow" };
  if (req.kind === "edit" && ctx.mode === "acceptEdits") return { behavior: "allow" };

  const suggestion = suggestRule(req, ctx.cwd);
  return suggestion ? { behavior: "ask", suggestion } : { behavior: "ask" };
}

function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/);
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
    return `${req.toolName}(${commandPrefix(parts[0]!)}:*)`;
  }
  if (req.kind === "edit" && req.paths.length > 0) {
    const dir = dirname(req.paths[0]!);
    if (!isInside(dir, cwd)) return undefined;
    const rel = relative(cwd, dir);
    return `Edit(${rel ? `${rel}/` : ""}**)`;
  }
  return undefined;
}
