// src/doctor/checks/workspace.ts — each registered project can be a chat workspace and is a git repository.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspaceProblem } from "../../gateway/policy";
import type { Check, Finding } from "../types";
import { finding } from "../util";

export const workspaceCheck: Check = {
  id: "workspace.projects",
  area: "workspace",
  title: "Projects are safe workspaces",
  async run(env) {
    const projects = await env.runner.listProjects(env.home);
    if (projects.length === 0) return [finding("workspace.projects", "info", "No projects registered")];
    const out: Finding[] = [];
    for (const p of projects) {
      const id = `workspace.projects.${p.id}`;
      if (!existsSync(p.path) && p.builtin) {
        out.push(finding(id, "ok", `Project ${p.id}: ${p.path} is created on first use`));
        continue;
      }
      if (!existsSync(p.path)) {
        out.push(finding(id, "error", `Project ${p.id}: ${p.path} does not exist`));
        continue;
      }
      const problem = workspaceProblem(p.path, env.home, env.userHome);
      if (problem) {
        out.push(finding(id, "error", `Project ${p.id}: ${problem}`));
      } else if (!existsSync(join(p.path, ".git"))) {
        // Without a .git there is nothing to protect: a command in the sandbox could create one with a hook the owner later runs.
        out.push(finding(id, "warn", `Project ${p.id}: ${p.path} is not a git repository`, { detail: `Run \`git init\` there: without a .git, a chat's command could create one with a hook in it.` }));
      } else {
        out.push(finding(id, "ok", `Project ${p.id}: ${p.path}`));
      }
    }
    return out;
  },
};
