// src/extensions/agent-manage.ts
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorText } from "../error-text";
import { Ledger } from "../learning/ledger";
import { agentsDir, isInside } from "../paths";
import { makeDiff } from "../tools/diff";
import { writeFileNoFollow } from "../tools/file-guard";
import { resolveToolPath } from "../tools/paths";
import { defineTool, type AnyTool, type ToolOutput } from "../tools/types";
import { archiveSpecialist, createSpecialist, ROLE_CONTRACT_TEMPLATE, SpecialistError, updateSpecialist, type SpecialistChange } from "../agents/store";
import { AGENT_FILE, fieldsProblem, loadSpecialists } from "../agents/specialists";
import { AUTONOMY_LEVELS } from "../gateway/config";
import { BUILTIN_AGENTS } from "./agents";
import { fmList, fmString, parseFrontmatter } from "./frontmatter";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const schema = z.object({
  action: z.enum(["create", "update", "delete", "archive"]),
  name: z.string().max(40).regex(NAME, "kebab-case: lowercase letters, digits and single hyphens").describe("The agent's name, e.g. george or code-reviewer."),
  description: z.string().optional().describe("create/update: one line saying what the agent does and when to use it (the Agent tool lists it)."),
  prompt: z.string().optional().describe("create/update: the role contract, with the sections ## Purpose, ## Not my job, ## Report and ## Escalate when."),
  tools: z.array(z.string()).optional().describe('create/update: the tools it may use, e.g. ["Read", "Grep", "Glob", "WebFetch"]; omit for all tools.'),
  model: z.string().optional().describe('create/update: a model id or alias (opus, sonnet, haiku); omit to use the session\'s model.'),
  emoji: z.string().optional().describe("create/update: one emoji shown next to its name."),
  autonomy: z.enum(AUTONOMY_LEVELS).optional().describe("create/update: how freely it acts on its own (ask, balanced, autonomous); omit to follow the session's."),
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

/**
 * What the permission dialog shows: the whole new file for create (the prompt becomes the agent's system
 * prompt in every later session), the fields that change for update.
 */
export function agentPreview(input: Input, path: string): { header: string; text: string } {
  if (input.action === "delete") return { header: path, text: `Delete agent ${input.name}.` };
  if (input.action === "archive") return { header: path, text: `Archive specialist ${input.name}. It can be restored from the Agents page.` };
  const unlimited = input.tools === undefined || input.tools.length === 0;
  if (input.action === "create") {
    const text = renderAgentFile(input.name, { description: input.description ?? "", prompt: input.prompt ?? "", tools: input.tools, model: input.model, emoji: input.emoji });
    return { header: unlimited ? `${path} · may use every tool` : path, text };
  }
  const changes: string[] = [];
  if (input.description !== undefined) changes.push(`description: ${input.description}`);
  if (input.tools !== undefined) changes.push(`tools: ${unlimited ? "every tool" : input.tools.join(", ")}`);
  if (input.model !== undefined) changes.push(`model: ${input.model}`);
  if (input.emoji !== undefined) changes.push(`emoji: ${input.emoji}`);
  if (input.autonomy !== undefined) changes.push(`autonomy: ${input.autonomy}`);
  if (input.prompt !== undefined) changes.push("prompt:", input.prompt);
  return { header: `${path} · update`, text: changes.length > 0 ? changes.join("\n") : "(no changes)" };
}

export interface AgentManageOptions {
  home: string;
  ledger?: Ledger;
  /** Called after a change, so the session's agent list (and the Agent tool) sees it at once. */
  onChange?(): Promise<void> | void;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * AgentManage: creates and maintains the user's specialists (<home>/agents/<name>/AGENT.md, the helpers the Agent
 * tool starts by name) and still edits single-file agents (<home>/agents/<name>.md). Kind "edit" on files outside
 * the project, so every change asks unless it is one of the owner's store saves. A definition is prompt text plus a
 * tool list and a model: it can narrow what a subagent may do, never widen the permissions.
 */
export function createAgentManageTool(opts: AgentManageOptions): AnyTool {
  const root = () => agentsDir(opts.home);
  const plainPath = (name: string) => join(root(), `${name}.md`);
  const specialistPath = (name: string) => join(root(), name, AGENT_FILE);
  /** A single-file agent when one exists under that name; everything else is a specialist. */
  const isPlain = (name: string) => existsSync(plainPath(name));
  const pathOf = (name: string) => (isPlain(name) ? plainPath(name) : specialistPath(name));
  const ledger = () => opts.ledger ?? new Ledger(opts.home);

  async function record(path: string, action: string, summary: string, before: string | null, after: string | null, actor: Parameters<Ledger["record"]>[0]["actor"]): Promise<void> {
    await opts.ledger?.record({ actor, kind: "agent", path, action, summary, before, after }).catch(() => {});
  }

  async function runSpecialist(input: Input, path: string, actor: NonNullable<Parameters<Ledger["record"]>[0]["actor"]>): Promise<ToolOutput> {
    const common = { ledger: ledger(), actor };
    const read = () => readFile(path, "utf8").catch(() => "");
    if (input.action === "create") {
      const made = await createSpecialist(
        opts.home,
        { id: input.name, description: input.description ?? "", prompt: input.prompt ?? "", emoji: input.emoji, model: input.model, tools: input.tools, autonomy: input.autonomy },
        common,
      );
      await opts.onChange?.();
      return {
        content: `Created specialist ${input.name} at ${made.dir}. Start it with the Agent tool (subagent_type: "${input.name}").`,
        display: makeDiff(path, "", await read()),
        summary: "created",
      };
    }
    if (input.action === "archive") {
      const dir = await archiveSpecialist(opts.home, input.name, common);
      await opts.onChange?.();
      return { content: `Archived specialist ${input.name} (${dir}). It can be restored from the Agents page.`, summary: "archived" };
    }
    if (input.action === "delete") return fail("Specialists are never deleted; use archive. They can be restored from the Agents page.");
    const before = await read();
    const change: SpecialistChange = {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      // An empty list means every tool, as for single-file agents.
      ...(input.tools !== undefined ? { tools: input.tools.length > 0 ? input.tools : null } : {}),
      ...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
    };
    const updated = await updateSpecialist(opts.home, input.name, change, common);
    await opts.onChange?.();
    return {
      content: `Updated specialist ${input.name} (revision ${updated.revision}). Start it with the Agent tool (subagent_type: "${input.name}").`,
      display: makeDiff(path, before, await read()),
      summary: "updated",
    };
  }

  return defineTool({
    name: "AgentManage",
    kind: "edit",
    description:
      "Create and maintain specialists: persistent helpers for a kind of work that keeps coming back (a PR reviewer, a release manager). " +
      "Each lives in ~/.tropos/agents/<name>/ with its own role contract, memory, journal and skills, and is started with the Agent tool (subagent_type = its name). " +
      "create: needs description (one line the chief routes on) and prompt, a role contract with these sections:\n" +
      `${ROLE_CONTRACT_TEMPLATE}\n` +
      "tools: the fewest that do the job (a subset of yours); model: omit to use yours. update: changes only the fields given and saves a new revision. " +
      "archive: retires one (never deleted). delete: only for single-file agents (~/.tropos/agents/<name>.md).",
    schema,
    summarize: (input) =>
      input.action === "create" && input.description
        ? `create ${input.emoji ? `${input.emoji} ` : ""}${input.name} — ${clip(input.description, 60)}`
        : `${input.action} ${input.emoji ? `${input.emoji} ` : ""}${input.name}`,
    // Archiving moves a whole folder (memory, skills): the ledger undoes the file, so the owner is always asked.
    subject: (input) => ({ paths: [input.action === "create" ? specialistPath(input.name) : pathOf(input.name)], ...(input.action === "archive" ? { destructive: true } : {}) }),
    preview: (input) => agentPreview(input, input.action === "create" ? specialistPath(input.name) : pathOf(input.name)),
    async run(input: Input, ctx) {
      const actor = ctx.actor ?? "agent";
      const plain = input.action !== "create" && isPlain(input.name);
      let path: string;
      try {
        path = resolveToolPath(input.action === "create" ? specialistPath(input.name) : pathOf(input.name), "/");
        if (!isInside(path, resolveToolPath(root(), "/"))) return fail(`${input.name} resolves outside ${root()}.`);
      } catch (error) {
        return fail(`Cannot ${input.action} agent ${input.name}: ${errorText(error)}`);
      }
      if (ctx.approvedPaths !== undefined && !ctx.approvedPaths.includes(path)) return fail(`${path} changed after it was approved; nothing was written. Try again.`);
      if (BUILTIN_AGENTS.some((b) => b.name === input.name)) return fail(`${input.name} is a built-in agent; pick another name.`);
      if (!plain) {
        try {
          return await runSpecialist(input, path, actor);
        } catch (error) {
          return fail(error instanceof SpecialistError ? error.message : `Cannot ${input.action} agent ${input.name}: ${errorText(error)}`);
        }
      }
      if (input.action === "archive") return fail(`${input.name} is a single-file agent; archive is for specialists. Delete it instead.`);
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
        const fields: Partial<Fields> = {
          ...(before === null ? {} : parseAgentFile(before)),
          ...Object.fromEntries(Object.entries({ description: input.description, prompt: input.prompt, tools: input.tools, model: input.model, emoji: input.emoji }).filter(([, v]) => v !== undefined)),
        };
        if (fields.emoji !== undefined) fields.emoji = fields.emoji.trim();
        const why = fieldsProblem(fields);
        if (why) return fail(why);
        const after = renderAgentFile(input.name, fields as Fields);
        await mkdir(root(), { recursive: true, mode: 0o700 });
        await record(path, "update", `updated agent ${fields.emoji ? `${fields.emoji} ` : ""}${input.name}`, before, after, actor);
        await writeFileNoFollow(path, after);
        await opts.onChange?.();
        return {
          content: `Updated agent ${input.name} at ${path}. Start it with the Agent tool (subagent_type: "${input.name}").`,
          display: makeDiff(path, before ?? "", after),
          summary: "updated",
        };
      } catch (error) {
        return fail(`Cannot ${input.action} agent ${input.name}: ${errorText(error)}`);
      }
    },
  }) as AnyTool;
}
