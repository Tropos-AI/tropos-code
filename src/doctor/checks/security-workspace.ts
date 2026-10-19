// src/doctor/checks/security-workspace.ts — project directories a chat can touch.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { workspaceProblem } from "../../gateway/policy";
import type { Check, Finding } from "../types";
import { finding } from "../util";

export const securityWorkspaceCheck: Check = {
  id: "security.workspace",
  area: "security",
  audit: true,
  title: "Workspaces",
  async run(env) {
    const projects = await env.runner.listProjects(env.home);
    if (projects.length === 0) return [finding("security.workspace", "ok", "No projects registered")];
    const out: Finding[] = [];
    for (const p of projects) {
      const id = `security.workspace.${p.id}`;
      if (!existsSync(p.path)) continue; // the workspace check reports a missing directory
      const problems: Finding[] = [];
      const bad = p.builtin ? undefined : workspaceProblem(p.path, env.home, env.userHome);
      if (bad) problems.push(finding(id, "error", `Project ${p.id}: ${bad}`, { detail: "A chat could read your credentials or Tropos's own settings." }));
      if (env.platform !== "win32" && (statSync(p.path).mode & 0o002) !== 0) {
        problems.push(finding(`${id}.writable`, "warn", `Project ${p.id}: ${p.path} is writable by every user`, { detail: `Fix: chmod o-w ${p.path}` }));
      }
      if (!existsSync(join(p.path, ".git"))) {
        problems.push(finding(`${id}.git`, "warn", `Project ${p.id}: no .git in ${p.path}`, { detail: "Without one, a sandboxed command could create .git/hooks that run when you next use git there." }));
      }
      out.push(...(problems.length ? problems : [finding(id, "ok", `Project ${p.id} is confined and a git repository`)]));
    }
    return out as Finding[];
  },
};
