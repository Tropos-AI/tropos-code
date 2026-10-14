// src/extensions/agents.ts
import { join } from "node:path";
import { isAnthropicModelId } from "../config/settings";
import { errorText } from "../error-text";
import { listMarkdown, MAX_EXTENSION_BYTES, NAME_SEGMENT, readCapped } from "./commands";
import { fmList, fmString, parseFrontmatter } from "./frontmatter";
import { qualifiedName, staysInProject, type ExtensionDir, type ExtensionSource } from "./sources";

export interface AgentDefinition {
  name: string;
  description: string;
  /** Tools the agent may use; undefined means every tool except Agent. */
  tools?: string[];
  disallowedTools?: string[];
  /** A model id; undefined means the parent's model ("inherit"). */
  model?: string;
  maxTurns?: number;
  /** The agent's instructions, appended to the system prompt as `# Agent: <name>`. */
  prompt: string;
  source: ExtensionSource | "builtin";
  path?: string;
}

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebFetch"];

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "general-purpose",
    description: "General agent for multi-step tasks: researching questions, searching code and making changes.",
    prompt: [
      "You are working on one task delegated by another agent, which sees only your final message.",
      "- Do the whole task with the tools you have; don't stop at a plan unless that is what was asked.",
      "- Search broadly when you don't know where something lives, then read what matters.",
      "- Change only what the task needs, in the style of the surrounding code.",
      "- End with a concise report: what you did or found, file paths as path:line, and anything left undone or uncertain.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "explore",
    description: "Read-only codebase search: finds files, symbols and how things work, and reports back. Never changes files.",
    tools: READ_ONLY_TOOLS,
    prompt: [
      "You explore a codebase to answer a question for another agent, which sees only your final message.",
      "- You are read-only. Never create, edit or delete files. Use Bash only for read-only commands (git log, git diff, ls, and the like).",
      "- Start broad with Glob and Grep, then Read the parts that matter. Try other names and locations before concluding something doesn't exist.",
      "- Run independent searches in parallel.",
      "- Report findings, not a narrative of the search: the answer first, then the evidence as path:line references, then open questions.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "plan",
    description: "Read-only planner: studies the code and returns a step-by-step implementation plan. Never changes files.",
    tools: READ_ONLY_TOOLS,
    prompt: [
      "You design an implementation plan for another agent, which sees only your final message.",
      "- You are read-only. Never create, edit or delete files. Use Bash only for read-only commands.",
      "- Study the relevant code first: existing patterns, the files involved, tests and constraints.",
      "- Return a numbered, step-by-step plan. For each step name the files and functions to change and what changes.",
      "- Call out risks, decisions the caller must make, and how to verify the result (tests to add or run).",
      "- Prefer the smallest design that fits the existing code over new abstractions.",
    ].join("\n"),
    source: "builtin",
  },
];

/** Parses maxTurns; anything but a positive integer is reported and ignored. */
function parseMaxTurns(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : "invalid";
}

/**
 * Loads agent definitions, highest-precedence folder first (project, user, then plugins); the
 * first of each name wins, and a loaded agent replaces a built-in of the same name. A file without
 * a frontmatter `name` is skipped silently so docs can live alongside. A project agent's model must
 * be an Anthropic one: any other id would send the session to a provider the repo chose.
 */
export async function loadAgents(dirs: ExtensionDir[]): Promise<{ agents: AgentDefinition[]; warnings: string[] }> {
  const warnings: string[] = [];
  const loaded = new Map<string, AgentDefinition>();
  for (const dir of dirs) {
    for (const rel of await listMarkdown(dir.dir, warnings)) {
      const path = join(dir.dir, rel);
      if (!(await staysInProject(dir, path))) {
        warnings.push(`Skipped agent file ${path}: it links outside the project`);
        continue;
      }
      let text: string;
      try {
        const read = await readCapped(path);
        if (read.truncated) warnings.push(`Agent file ${path} was cut to ${MAX_EXTENSION_BYTES / 1024} KB`);
        text = read.text;
      } catch (err) {
        warnings.push(`Cannot read agent ${path}: ${errorText(err)}`);
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const bare = fmString(data, "name");
      if (!bare) continue;
      if (!NAME_SEGMENT.test(bare)) {
        warnings.push(`Skipped agent "${bare}" (${path}): names use letters, digits, ".", "_" and "-"`);
        continue;
      }
      const name = qualifiedName(dir, bare);
      if (loaded.has(name)) continue;
      // A built-in is what the model reaches for by default: a cloned repo must not rewrite it.
      if (dir.source === "project" && BUILTIN_AGENTS.some((b) => b.name === name)) {
        warnings.push(`Skipped agent ${name} (${path}): a project agent can't replace a built-in one; give it another name`);
        continue;
      }
      const description = fmString(data, "description");
      if (!description) {
        warnings.push(`Skipped agent ${name}: no description (${path})`);
        continue;
      }
      let model = fmString(data, "model");
      if (model === "inherit") model = undefined;
      if (model && dir.source === "project" && !isAnthropicModelId(model)) {
        warnings.push(`Agent ${name} ignores model "${model}": a project agent may only pick an Anthropic model`);
        model = undefined;
      }
      const maxTurns = parseMaxTurns(data.maxTurns);
      if (maxTurns === "invalid") warnings.push(`Agent ${name} ignores maxTurns: it must be a positive whole number`);
      const tools = fmList(data, "tools");
      loaded.set(name, {
        name,
        description: description.replace(/\s+/g, " "),
        tools: tools && !tools.includes("*") ? tools : undefined,
        disallowedTools: fmList(data, "disallowedTools"),
        model,
        maxTurns: maxTurns === "invalid" ? undefined : maxTurns,
        prompt: body.trim(),
        source: dir.source,
        path,
      });
    }
  }
  const agents = BUILTIN_AGENTS.map((agent) => loaded.get(agent.name) ?? agent);
  for (const agent of loaded.values()) if (!BUILTIN_AGENTS.some((b) => b.name === agent.name)) agents.push(agent);
  return { agents, warnings };
}
