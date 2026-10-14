// src/extensions/agent-manage.ts
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isEmojiLike } from "../context/identity";
import { errorText } from "../error-text";
import type { Ledger } from "../learning/ledger";
import { scanText } from "../learning/threats";
import { isInside } from "../paths";
import { makeDiff } from "../tools/diff";
import { writeFileNoFollow } from "../tools/file-guard";
import { resolveToolPath } from "../tools/paths";
import { defineTool, type AnyTool, type ToolOutput } from "../tools/types";
import { BUILTIN_AGENTS } from "./agents";
import { fmList, fmString, parseFrontmatter } from "./frontmatter";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PROMPT_CHARS = 20_000;
const MAX_DESCRIPTION_CHARS = 500;

const schema = z.object({
  action: z.enum(["create", "update", "delete"]),
  name: z.string().max(40).regex(NAME, "kebab-case: lowercase letters, digits and single hyphens").describe("The agent's name, e.g. george or code-reviewer."),
  description: z.string().optional().describe("create/update: one line saying what the agent does and when to use it (the Agent tool lists it)."),
  prompt: z.string().optional().describe("create/update: the agent's instructions: its role, how it works, and what its final report must contain."),
  tools: z.array(z.string()).optional().describe('create/update: the tools it may use, e.g. ["Read", "Grep", "Glob", "WebFetch"]; omit for all tools.'),
  model: z.string().optional().describe('create/update: a model id or alias (opus, sonnet, haiku); omit to use the session\'s model.'),
  emoji: z.string().optional().describe("create/update: one emoji shown next to its name."),
});

type Input = z.infer<typeof schema>;

interface Fields {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  emoji?: string;
}

function fail(content: string): ToolOutput {
  return { content, isError: true };
}

/** The agent file: YAML frontmatter (strings JSON-quoted, which YAML reads as is) and the instructions. */
export function renderAgentFile(name: string, f: Fields): string {
  const lines = ["---", `name: ${name}`, `description: ${JSON.stringify(f.description)}`];
  if (f.tools && f.tools.length > 0) lines.push(`tools: ${JSON.stringify(f.tools.join(", "))}`);
  if (f.model) lines.push(`model: ${JSON.stringify(f.model)}`);
  if (f.emoji) lines.push(`emoji: ${JSON.stringify(f.emoji)}`);
  lines.push("---", "", f.prompt.trim(), "");
  return lines.join("\n");
}

function parseAgentFile(text: string): Partial<Fields> {
  const { data, body } = parseFrontmatter(text);
  return {
    description: fmString(data, "description"),
    prompt: body.trim() || undefined,
    tools: fmList(data, "tools"),
    model: fmString(data, "model"),
    emoji: fmString(data, "emoji"),
  };
}

/** Why the fields can't be saved, or undefined. */
function problem(f: Partial<Fields>): string | undefined {
  if (!f.description?.trim()) return "description is required: one line saying what the agent does and when to use it.";
  if (/[\r\n]/.test(f.description)) return "description must be a single line.";
  if (f.description.length > MAX_DESCRIPTION_CHARS) return `description is over ${MAX_DESCRIPTION_CHARS} chars.`;
  if (!f.prompt?.trim()) return "prompt is required: the agent's instructions.";
  if (f.prompt.length > MAX_PROMPT_CHARS) return `prompt is over ${MAX_PROMPT_CHARS.toLocaleString("en-US")} chars.`;
  if (f.emoji !== undefined && !isEmojiLike(f.emoji)) return "emoji must be a single emoji.";
  if (f.model !== undefined && !/^[\w./:-]{1,100}$/.test(f.model)) return "model must be a model id such as claude-sonnet-5-5, or an alias (opus, sonnet, haiku).";
  if (f.tools?.some((t) => !/^[\w*:().-]{1,100}$/.test(t))) return "tools must be tool names such as Read, Grep or mcp__github__*.";
  const scan = scanText([f.description, f.prompt].join("\n"));
  if (!scan.ok) return `Not saved: ${scan.reason}.`;
  return undefined;
}

export interface AgentManageOptions {
  home: string;
  ledger?: Ledger;
  /** Called after a change, so the session's agent list (and the Agent tool) sees it at once. */
  onChange?(): Promise<void> | void;
}

/**
 * AgentManage: creates the user's own subagents in <home>/agents/<name>.md, the files the Agent tool
 * starts by name. Kind "edit" on files outside the project, so every change asks. An agent file is prompt
 * text plus a tool list and a model: it can narrow what a subagent may do, never widen the permissions.
 */
export function createAgentManageTool(opts: AgentManageOptions): AnyTool {
  const root = () => join(opts.home, "agents");
  const pathOf = (name: string) => join(root(), `${name}.md`);

  async function record(path: string, action: string, summary: string, before: string | null, after: string | null, actor: Parameters<Ledger["record"]>[0]["actor"]): Promise<void> {
    await opts.ledger?.record({ actor, kind: "agent", path, action, summary, before, after }).catch(() => {});
  }

  return defineTool({
    name: "AgentManage",
    kind: "edit",
    description:
      "Create, update or delete the user's own subagents (~/.tropos/agents/<name>.md): named helpers such as a researcher or a reviewer, " +
      "each with a role, instructions, an optional tool list, model and emoji. Use it when the user asks for a new agent. " +
      "A created agent can be started right away with the Agent tool (subagent_type = its name). " +
      "create: needs description and prompt. update: changes only the fields given. delete: removes the file.",
    schema,
    summarize: (input) => `${input.action} ${input.emoji ? `${input.emoji} ` : ""}${input.name}`,
    subject: (input) => ({ paths: [pathOf(input.name)] }),
    async run(input: Input, ctx) {
      const actor = ctx.actor ?? "agent";
      let path: string;
      try {
        path = resolveToolPath(pathOf(input.name), "/");
        if (!isInside(path, resolveToolPath(root(), "/"))) return fail(`${input.name} resolves outside ${root()}.`);
      } catch (error) {
        return fail(`Cannot ${input.action} agent ${input.name}: ${errorText(error)}`);
      }
      if (ctx.approvedPaths !== undefined && !ctx.approvedPaths.includes(path)) return fail(`${path} changed after it was approved; nothing was written. Try again.`);
      if (BUILTIN_AGENTS.some((b) => b.name === input.name)) return fail(`${input.name} is a built-in agent; pick another name.`);
      const before = await readFile(path, "utf8").catch(() => null);
      try {
        if (input.action === "delete") {
          if (before === null) return fail(`No agent named ${input.name} (${path}).`);
          if (!(await lstat(path)).isFile()) return fail(`${path} is not a plain file; delete it by hand.`);
          await record(path, "delete", `deleted agent ${input.name}`, before, null, actor);
          await rm(path);
          await opts.onChange?.();
          return { content: `Deleted agent ${input.name} (${path}).`, summary: "deleted" };
        }
        if (input.action === "create" && before !== null) return fail(`Agent ${input.name} already exists at ${path}. Use update to change it.`);
        if (input.action === "update" && before === null) return fail(`No agent named ${input.name} (${path}). Use create.`);
        const fields: Partial<Fields> = {
          ...(before === null ? {} : parseAgentFile(before)),
          ...Object.fromEntries(Object.entries({ description: input.description, prompt: input.prompt, tools: input.tools, model: input.model, emoji: input.emoji }).filter(([, v]) => v !== undefined)),
        };
        if (fields.emoji !== undefined) fields.emoji = fields.emoji.trim();
        const why = problem(fields);
        if (why) return fail(why);
        const after = renderAgentFile(input.name, fields as Fields);
        await mkdir(root(), { recursive: true, mode: 0o700 });
        await record(path, input.action, `${input.action === "create" ? "created" : "updated"} agent ${fields.emoji ? `${fields.emoji} ` : ""}${input.name}`, before, after, actor);
        await writeFileNoFollow(path, after);
        await opts.onChange?.();
        return {
          content: `${input.action === "create" ? "Created" : "Updated"} agent ${input.name} at ${path}. Start it with the Agent tool (subagent_type: "${input.name}").`,
          display: makeDiff(path, before ?? "", after),
          summary: input.action === "create" ? "created" : "updated",
        };
      } catch (error) {
        return fail(`Cannot ${input.action} agent ${input.name}: ${errorText(error)}`);
      }
    },
  }) as AnyTool;
}
