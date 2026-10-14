// src/memory/skill-manage.ts
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import { errorText } from "../error-text";
import { fmString, parseFrontmatter } from "../extensions/frontmatter";
import type { Ledger } from "../learning/ledger";
import type { SkillTracker } from "../learning/skill-tracker";
import { scanText } from "../learning/threats";
import { isInside } from "../paths";
import { makeDiff } from "../tools/diff";
import { writeFileNoFollow } from "../tools/file-guard";
import { resolveToolPath } from "../tools/paths";
import { defineTool, type Actor, type AnyTool, type ToolOutput } from "../tools/types";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A skill is prompt text; anything bigger than this is almost certainly a mistake. */
export const MAX_SKILL_FILE_CHARS = 100_000;

const schema = z.object({
  action: z.enum(["create", "patch", "write_file", "delete"]),
  name: z.string().max(64).regex(NAME, "kebab-case: lowercase letters, digits and single hyphens").describe("The skill's folder name, kebab-case."),
  content: z.string().optional().describe("create: the full SKILL.md, starting with frontmatter that has a description."),
  old_string: z.string().optional().describe("patch: exact text to replace; must be unique unless replace_all."),
  new_string: z.string().optional().describe("patch: replacement text."),
  replace_all: z.boolean().optional().describe("patch: replace every occurrence."),
  file_path: z.string().optional().describe("patch / write_file: a path relative to the skill folder (patch defaults to SKILL.md)."),
  file_content: z.string().optional().describe("write_file: the file's full contents."),
});

type Input = z.infer<typeof schema>;

class SkillError extends Error {}

export interface SkillManageOptions {
  home: string;
  /** Records every write so the user can review and undo it. */
  ledger?: Ledger;
  /** When given, patch and write_file need the skill loaded (or created) in this session first. */
  tracker?: SkillTracker;
  /** The folder under home the skills live in: "skills" (default), or the learning review's own "skills-learned". */
  folder?: string;
}

/** The skills folder this tool writes to. */
function skillsBase(opts: SkillManageOptions): string {
  return join(opts.home, opts.folder ?? "skills");
}

/** What each action needs besides its input: where to record, and who is acting. */
interface Env {
  opts: SkillManageOptions;
  actor: Actor;
}

interface Layout {
  /** Canonical skill directory. */
  dir: string;
  /** Canonical file the action writes, or the directory for delete. */
  target: string;
  /** Relative path of the target inside the skill directory ("SKILL.md" by default). */
  rel: string;
}

/** Validates a model-supplied relative path lexically, before anything touches the disk. */
function relativePath(filePath: string | undefined): string {
  if (filePath === undefined) return "SKILL.md";
  if (filePath.trim() === "" || isAbsolute(filePath) || filePath.startsWith("~")) {
    throw new SkillError("file_path must be a path relative to the skill folder.");
  }
  const rel = normalize(filePath);
  if (rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || rel.endsWith(sep)) {
    throw new SkillError("file_path must name a file inside the skill folder.");
  }
  return rel;
}

/**
 * Resolves where an action lands, following symlinks the way the OS will. A symlinked skill folder
 * or file that points outside <home>/skills is refused, so a skill can't be used to write elsewhere.
 */
function layout(base: string, input: Input): Layout {
  const root = resolveToolPath(base, "/");
  const dir = resolveToolPath(join(base, input.name), "/");
  if (!isInside(dir, root) || dir === root) throw new SkillError(`skill folder for ${input.name} resolves outside ${root}.`);
  if (input.action === "delete") return { dir, target: dir, rel: "" };
  const rel = input.action === "create" ? "SKILL.md" : relativePath(input.file_path);
  const target = resolveToolPath(join(dir, rel), "/");
  if (!isInside(target, dir) || target === dir) throw new SkillError(`${rel} resolves outside the skill folder.`);
  return { dir, target, rel };
}

/** Why a SKILL.md can't be loaded, or undefined when it is fine. */
function skillFileProblem(text: string): string | undefined {
  const { data } = parseFrontmatter(text);
  if (!fmString(data, "description")) {
    return "SKILL.md must start with frontmatter (--- … ---) holding a non-empty description, e.g.\n---\ndescription: What this skill does and when to use it.\n---";
  }
  return undefined;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

function fail(content: string): ToolOutput {
  return { content, isError: true };
}

/** Skills are prompt text for every later session: refuse text that tries to steer or leak. */
function unsafe(text: string): string | undefined {
  const scan = scanText(text);
  return scan.ok ? undefined : `Refused: the content looks unsafe (${scan.reason}). Skills are loaded as instructions in later sessions, so they may not carry injected instructions, secret exfiltration or hidden characters.`;
}

/** Records the change before the write, so a failed write leaves an entry undo refuses rather than a silent change. */
async function record(env: Env, input: Input, path: string, action: string, before: string | null, after: string | null): Promise<void> {
  const rel = input.file_path && action !== "create" && action !== "delete" ? `/${input.file_path}` : "";
  await env.opts.ledger?.record({ actor: env.actor, kind: "skill", path, action, summary: `${action} ${input.name}${rel}`, before, after });
}

async function create(input: Input, at: Layout, env: Env): Promise<ToolOutput> {
  if (input.content === undefined) return fail("create needs content: the full SKILL.md.");
  if (existsSync(at.dir)) return fail(`Skill ${input.name} already exists at ${at.dir}. Use patch or write_file to change it.`);
  if (input.content.length > MAX_SKILL_FILE_CHARS) return fail(`content is over ${MAX_SKILL_FILE_CHARS.toLocaleString("en-US")} chars.`);
  const problem = skillFileProblem(input.content) ?? unsafe(input.content);
  if (problem) return fail(problem);
  await record(env, input, at.target, "create", null, input.content);
  await mkdir(at.dir, { recursive: true, mode: 0o700 });
  await writeFileNoFollow(at.target, input.content);
  env.opts.tracker?.markViewed(input.name);
  return {
    content: `Created skill ${input.name} at ${at.target}. It joins the skill listing in the next session.`,
    display: makeDiff(at.target, "", input.content),
    summary: "created",
  };
}

async function requireSkill(input: Input, at: Layout): Promise<void> {
  if (!existsSync(join(at.dir, "SKILL.md"))) throw new SkillError(`No skill named ${input.name} (no ${join(at.dir, "SKILL.md")}).`);
}

async function patch(input: Input, at: Layout, env: Env): Promise<ToolOutput> {
  if (input.old_string === undefined || input.new_string === undefined) return fail("patch needs old_string and new_string.");
  if (input.old_string === "") return fail("old_string is empty; give the exact text to replace.");
  if (input.old_string === input.new_string) return fail("old_string and new_string are identical, so there is nothing to change.");
  await requireSkill(input, at);
  let original: string;
  try {
    original = await readFile(at.target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fail(`${at.rel} does not exist in skill ${input.name}.`);
    throw error;
  }
  const count = countOccurrences(original, input.old_string);
  if (count === 0) return fail(`old_string was not found in ${at.target}.`);
  if (count > 1 && !input.replace_all) {
    return fail(`old_string appears ${count} times in ${at.target}. Include more context to make it unique, or set replace_all.`);
  }
  // split/join and slicing insert the text literally; String.replace would expand $&, $1, $$.
  let updated: string;
  if (input.replace_all) updated = original.split(input.old_string).join(input.new_string);
  else {
    const i = original.indexOf(input.old_string);
    updated = original.slice(0, i) + input.new_string + original.slice(i + input.old_string.length);
  }
  if (updated.length > MAX_SKILL_FILE_CHARS) return fail(`The result would be over ${MAX_SKILL_FILE_CHARS.toLocaleString("en-US")} chars.`);
  if (at.rel === "SKILL.md") {
    const problem = skillFileProblem(updated);
    if (problem) return fail(`Not saved: ${problem}`);
  }
  const danger = unsafe(updated);
  if (danger) return fail(danger);
  await record(env, input, at.target, "patch", original, updated);
  await writeFileNoFollow(at.target, updated);
  const diff = makeDiff(at.target, original, updated);
  const n = input.replace_all ? count : 1;
  return {
    content: `Patched ${at.target} (${n} replacement${n === 1 ? "" : "s"}, +${diff.added} −${diff.removed}).`,
    display: diff,
    summary: `+${diff.added} −${diff.removed}`,
  };
}

async function writeFileAction(input: Input, at: Layout, env: Env): Promise<ToolOutput> {
  if (input.file_path === undefined || input.file_content === undefined) return fail("write_file needs file_path and file_content.");
  if (input.file_content.length > MAX_SKILL_FILE_CHARS) return fail(`file_content is over ${MAX_SKILL_FILE_CHARS.toLocaleString("en-US")} chars.`);
  await requireSkill(input, at);
  if (at.rel === "SKILL.md") {
    const problem = skillFileProblem(input.file_content);
    if (problem) return fail(`Not saved: ${problem}`);
  }
  const danger = unsafe(input.file_content);
  if (danger) return fail(danger);
  const before = await readFile(at.target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  await record(env, input, at.target, "write_file", before, input.file_content);
  await mkdir(dirname(at.target), { recursive: true, mode: 0o700 });
  await writeFileNoFollow(at.target, input.file_content);
  const diff = makeDiff(at.target, before ?? "", input.file_content);
  return { content: `Wrote ${at.target}.`, display: diff, summary: `+${diff.added} −${diff.removed}` };
}

async function remove(input: Input, at: Layout, env: Env): Promise<ToolOutput> {
  if (env.actor === "review") return fail("The background review may not delete skills; patch it instead, or leave it to the user.");
  await requireSkill(input, at);
  // A symlinked skill folder is left alone: deleting its target would surprise whoever made the link.
  if (!(await lstat(join(skillsBase(env.opts), input.name)).catch(() => null))?.isDirectory()) {
    return fail(`${at.dir} is not a plain skill folder; delete it by hand.`);
  }
  // The ledger keeps SKILL.md, the part worth restoring; supporting files go with the folder.
  const skillFile = join(at.dir, "SKILL.md");
  await record(env, input, skillFile, "delete", await readFile(skillFile, "utf8"), null);
  await rm(at.dir, { recursive: true, force: true });
  return { content: `Deleted skill ${input.name} (${at.dir}).`, display: { kind: "text", text: `Deleted ${at.dir}` }, summary: "deleted" };
}

/**
 * SkillManage: lets the model write its own skills under <home>/skills, the procedures it learned and
 * wants to reuse. Kind "edit"; the paths are outside the project, so the permission engine always asks.
 */
export function createSkillManageTool(opts: SkillManageOptions): AnyTool {
  return defineTool({
    name: "SkillManage",
    kind: "edit",
    description:
      "Create and maintain your own reusable skills in the user's skill folder (~/.tropos/skills/<name>/SKILL.md). " +
      "Use it when you worked out a procedure worth reusing in later sessions. " +
      "create: content is the full SKILL.md, starting with frontmatter that has a description saying what it does and when " +
      "to use it, followed by concise step-by-step instructions; fails if the skill exists. " +
      "patch: replace old_string with new_string in SKILL.md (or file_path); old_string must be unique unless replace_all. " +
      "write_file: write a supporting file (script, template, reference) at file_path relative to the skill folder. " +
      "delete: remove the whole skill. New skills join the listing in the next session. " +
      "Load a skill with the Skill tool before you patch it or write its files, and prefer patching an existing skill over creating a near-duplicate.",
    schema,
    summarize: (input) => `${input.action} ${input.name}${input.file_path ? `/${input.file_path}` : ""}`,
    subject: (input) => {
      try {
        return { paths: [layout(skillsBase(opts), input).target] };
      } catch {
        // Invalid input: name the skills folder so the call still asks; run reports the real problem.
        return { paths: [join(skillsBase(opts), input.name)] };
      }
    },
    async run(input, ctx) {
      let at: Layout;
      try {
        at = layout(skillsBase(opts), input);
      } catch (error) {
        return fail(`Cannot ${input.action} skill ${input.name}: ${errorText(error)}`);
      }
      if (ctx.approvedPaths !== undefined && !ctx.approvedPaths.includes(at.target)) {
        return fail(`${at.target} changed after it was approved; nothing was written. Try again.`);
      }
      const env: Env = { opts, actor: ctx.actor ?? "agent" };
      try {
        if ((input.action === "patch" || input.action === "write_file") && opts.tracker && !opts.tracker.hasViewed(input.name)) {
          await requireSkill(input, at);
          return fail(
            `Load skill ${input.name} with the Skill tool before changing it: ${input.action} needs its current instructions in this conversation.`,
          );
        }
        switch (input.action) {
          case "create":
            return await create(input, at, env);
          case "patch":
            return await patch(input, at, env);
          case "write_file":
            return await writeFileAction(input, at, env);
          case "delete":
            return await remove(input, at, env);
        }
      } catch (error) {
        return fail(error instanceof SkillError ? error.message : `Cannot ${input.action} skill ${input.name}: ${errorText(error)}`);
      }
    },
  }) as AnyTool;
}
