// src/agents/specialists.ts
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SubagentDefinition } from "../agent/subagent";
import { isEmojiLike } from "../context/identity";
import { errorText } from "../error-text";
import { agentLabel, BUILTIN_AGENTS, loadAgents, type AgentDefinition } from "../extensions/agents";
import { fmList, fmString, parseFrontmatter } from "../extensions/frontmatter";
import type { ExtensionDir } from "../extensions/sources";
import { AUTONOMY_LEVELS, type Autonomy } from "../gateway/config";
import { scanText } from "../learning/threats";
import { agentsDir } from "../paths";

/** A persistent helper: a folder ~/.tropos/agents/<id>/ whose AGENT.md holds its role contract. */
export interface Specialist extends SubagentDefinition {
  id: string;
  dir: string;
  autonomy?: Autonomy;
  createdBy: "user" | "chief" | "review";
  createdAt: number;
  revision: number;
  archived?: boolean;
  paused?: boolean;
}

export const MAX_ACTIVE_SPECIALISTS = 12;
export const MAX_PARALLEL_SPECIALISTS = 4;
export const SPECIALIST_IDLE_MS = 60 * 24 * 60 * 60 * 1000;
export const SPECIALIST_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const AGENT_FILE = "AGENT.md";
export const ARCHIVE_DIR = ".archive";
export const MAX_ID_CHARS = 40;
const MAX_PROMPT_CHARS = 20_000;
const MAX_DESCRIPTION_CHARS = 500;

export type SpecialistFields = Pick<
  Specialist,
  "name" | "description" | "prompt" | "emoji" | "model" | "tools" | "autonomy" | "createdBy" | "createdAt" | "revision" | "paused" | "maxTurns"
>;

/** Why the fields can't be saved, or undefined. */
export function fieldsProblem(f: { description?: string; prompt?: string; emoji?: string; model?: string; tools?: string[] }): string | undefined {
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

/** AGENT.md: YAML frontmatter (strings JSON-quoted, which YAML reads as is) and the role contract. */
export function renderSpecialistFile(f: SpecialistFields): string {
  const lines = ["---", `name: ${f.name}`, `description: ${JSON.stringify(f.description)}`];
  if (f.emoji) lines.push(`emoji: ${JSON.stringify(f.emoji)}`);
  if (f.model) lines.push(`model: ${JSON.stringify(f.model)}`);
  if (f.tools && f.tools.length > 0) lines.push(`tools: ${JSON.stringify(f.tools.join(", "))}`);
  if (f.autonomy) lines.push(`autonomy: ${f.autonomy}`);
  if (f.maxTurns !== undefined) lines.push(`maxTurns: ${f.maxTurns}`);
  lines.push(`createdBy: ${f.createdBy}`, `createdAt: ${JSON.stringify(new Date(f.createdAt).toISOString())}`, `revision: ${f.revision}`);
  if (f.paused) lines.push("paused: true");
  lines.push("---", "", f.prompt.trim(), "");
  return lines.join("\n");
}

const CREATED_BY = ["user", "chief", "review"] as const;

/** A string is the reason the file was refused. `fallbackCreatedAt` (the file's mtime) stands in when the header has none. */
export function parseSpecialistFile(id: string, dir: string, text: string, fallbackCreatedAt = 0): Specialist | string {
  if (!SPECIALIST_ID.test(id) || id.length > MAX_ID_CHARS) return `"${id}" is not a kebab-case name`;
  const { data, body } = parseFrontmatter(text);
  const name = fmString(data, "name");
  if (name !== id) return `its name${name ? ` "${name}"` : ""} does not match the folder`;
  const description = fmString(data, "description")?.replace(/\s+/g, " ");
  const prompt = body.trim();
  const tools = fmList(data, "tools");
  const emoji = fmString(data, "emoji");
  const model = fmString(data, "model");
  const why = fieldsProblem({ description, prompt, emoji, model, tools });
  if (why) return why;
  const autonomy = AUTONOMY_LEVELS.find((a) => a === fmString(data, "autonomy"));
  const createdBy = CREATED_BY.find((c) => c === fmString(data, "createdBy")) ?? "user";
  const revision = Number(fmString(data, "revision"));
  const created = Date.parse(fmString(data, "createdAt") ?? "");
  const maxTurns = Number(fmString(data, "maxTurns"));
  return {
    id,
    dir,
    name: id,
    description: description!,
    prompt,
    ...(tools && !tools.includes("*") && tools.length > 0 ? { tools } : {}),
    ...(model ? { model } : {}),
    ...(emoji ? { emoji } : {}),
    ...(autonomy ? { autonomy } : {}),
    ...(Number.isInteger(maxTurns) && maxTurns > 0 ? { maxTurns } : {}),
    createdBy,
    createdAt: Number.isFinite(created) ? created : fallbackCreatedAt,
    revision: Number.isInteger(revision) && revision >= 1 ? revision : 1,
    ...(fmString(data, "paused") === "true" ? { paused: true } : {}),
  };
}

/** Reads one specialist folder. Undefined when it has no AGENT.md (a plain folder, not ours); otherwise the specialist or a warning. */
async function readFolder(dir: string, id: string | undefined, warnings: string[], archived: boolean): Promise<Specialist | undefined> {
  const file = join(dir, AGENT_FILE);
  const info = await lstat(file).catch(() => null);
  if (!info) return undefined;
  if (!info.isFile()) {
    warnings.push(`Skipped specialist ${dir}: ${AGENT_FILE} is not a regular file`);
    return undefined;
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    warnings.push(`Cannot read specialist ${file}: ${errorText(err)}`);
    return undefined;
  }
  // An archived folder is named <id>-<date>; the id is what the file says.
  const parsed = parseSpecialistFile(id ?? fmString(parseFrontmatter(text).data, "name") ?? "", dir, text, info.mtimeMs);
  if (typeof parsed === "string") {
    warnings.push(`Skipped specialist ${dir}: ${parsed}`);
    return undefined;
  }
  return archived ? { ...parsed, archived: true } : parsed;
}

async function children(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

/** Active specialists sorted by id, then archived ones sorted by archive folder name. */
export async function loadSpecialists(home: string, warnings: string[] = []): Promise<Specialist[]> {
  const root = agentsDir(home);
  const active: Specialist[] = [];
  for (const name of await children(root)) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    const info = await lstat(dir).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      // A link to a plain file (agents/x.md) is none of our business; a link to a folder is refused.
      if ((await stat(dir).catch(() => null))?.isDirectory()) warnings.push(`Skipped specialist ${dir}: it is a symlink`);
      continue;
    }
    if (!info.isDirectory()) continue;
    const s = await readFolder(dir, name, warnings, false);
    if (s) active.push(s);
  }
  const archived: Specialist[] = [];
  const archiveRoot = join(root, ARCHIVE_DIR);
  for (const name of await children(archiveRoot)) {
    const dir = join(archiveRoot, name);
    if (!(await lstat(dir).catch(() => null))?.isDirectory()) continue;
    const s = await readFolder(dir, undefined, warnings, true);
    if (s) archived.push(s);
  }
  return [...active, ...archived];
}

export function isSpecialist(def: SubagentDefinition): def is Specialist {
  const s = def as Partial<Specialist>;
  return typeof s.id === "string" && typeof s.dir === "string" && typeof s.revision === "number";
}

export function specialistAgent(s: Specialist): AgentDefinition & Specialist {
  return { ...s, source: "specialist", path: join(s.dir, AGENT_FILE) };
}

/** Plain agents plus the active, unpaused specialists (after the built-ins). */
export async function loadAllAgents(dirs: ExtensionDir[], home: string): Promise<{ agents: AgentDefinition[]; warnings: string[] }> {
  const { agents, warnings } = await loadAgents(dirs);
  const all = (await loadSpecialists(home, warnings)).filter((s) => !s.archived);
  const taken = new Set<string>();
  const added: AgentDefinition[] = [];
  for (const s of all) {
    if (BUILTIN_AGENTS.some((b) => b.name === s.id)) {
      warnings.push(`Skipped specialist ${s.id} (${s.dir}): a built-in agent has that name`);
      continue;
    }
    taken.add(s.id);
    if (!s.paused) added.push(specialistAgent(s));
  }
  const plain = agents.filter((a) => {
    if (a.source === "builtin" || !taken.has(a.name)) return true;
    warnings.push(`Skipped agent ${a.name} (${a.path ?? a.source}): a specialist has that name`);
    return false;
  });
  plain.splice(BUILTIN_AGENTS.length, 0, ...added);
  return { agents: plain, warnings };
}

/** The chief's `<specialists>` block; empty when there are none. */
export function specialistRoster(agents: AgentDefinition[]): string {
  const live = agents.filter((a) => a.source === "specialist" && isSpecialist(a) && !a.archived && !a.paused);
  if (live.length === 0) return "";
  return [
    "<specialists>",
    "Specialists you lead. Delegate with the Agent tool (subagent_type: the id) when one fits; do it yourself when none does; never delegate what the user asked you personally to decide. " +
      "Each runs on its own model when one is shown, else on yours; pass model on the Agent call to pick a cheaper, faster or stronger one for a task, or the one the user names.",
    ...live.map((a) => `- ${agentLabel(a)}: ${a.description}${a.model ? ` (model: ${a.model})` : ""}`),
    "</specialists>",
  ].join("\n");
}
