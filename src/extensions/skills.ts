// src/extensions/skills.ts
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { neutraliseHarnessTags } from "../context/tags";
import { errorText } from "../error-text";
import { blockedPlaceholder, scanText } from "../learning/threats";
import { escapeAttr, MAX_EXTENSION_BYTES, NAME_SEGMENT, readCapped } from "./commands";
import { fmBool, fmString, parseFrontmatter } from "./frontmatter";
import { qualifiedName, staysInProject, type ExtensionDir, type ExtensionSource } from "./sources";

export interface Skill {
  name: string;
  description: string;
  whenToUse?: string;
  /** The skill's folder: the model reads its other files from here. */
  dir: string;
  path: string;
  body: string;
  source: ExtensionSource;
  modelInvocable: boolean;
  userInvocable: boolean;
}

/** Characters of the whole `<skills>` listing, tags included. */
export const SKILL_LISTING_BUDGET = 8_000;
const MAX_LINE = 250;
/** Other files listed after a rendered skill. */
const MAX_LISTED_FILES = 50;
const MAX_FILE_DEPTH = 4;

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Loads `<dir>/<name>/SKILL.md` skills, highest-precedence folder first; the first of each name
 * wins. The folder name is the skill's name (a differing frontmatter `name` is ignored, so a repo
 * cannot pose as another skill). A skill without a description is skipped with a warning: the
 * model could never know when to use it. A skill whose text fails the threat scan still loads (so
 * its name keeps shadowing lower-precedence ones) but its body, or description, becomes a
 * `[blocked: …]` placeholder and a warning says why.
 */
export async function loadSkills(dirs: ExtensionDir[]): Promise<{ skills: Skill[]; warnings: string[] }> {
  const warnings: string[] = [];
  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = (await readdir(dir.dir)).sort();
    } catch (err) {
      if (!isMissing(err)) warnings.push(`Cannot read ${dir.dir}: ${errorText(err)}`);
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const skillDir = join(dir.dir, entry);
      const path = join(skillDir, "SKILL.md");
      let text: string;
      try {
        // stat follows symlinks: linking a skill folder in from elsewhere is common.
        if (!(await stat(skillDir)).isDirectory()) continue;
        if (!(await staysInProject(dir, skillDir)) || !(await staysInProject(dir, path))) {
          warnings.push(`Skipped skill ${skillDir}: it links outside the project`);
          continue;
        }
        const read = await readCapped(path);
        if (read.truncated) warnings.push(`Skill ${entry} was cut to ${MAX_EXTENSION_BYTES / 1024} KB (${path})`);
        text = read.text;
      } catch (err) {
        if (!isMissing(err)) warnings.push(`Cannot read skill ${path}: ${errorText(err)}`);
        continue;
      }
      if (!NAME_SEGMENT.test(entry)) {
        warnings.push(`Skipped skill ${skillDir}: names use letters, digits, ".", "_" and "-"`);
        continue;
      }
      const name = qualifiedName(dir, entry);
      if (seen.has(name)) continue;
      const { data, body } = parseFrontmatter(text);
      const description = fmString(data, "description");
      if (!description) {
        warnings.push(`Skipped skill ${name}: SKILL.md has no description (${path})`);
        continue;
      }
      seen.add(name);
      const whenToUse = optionalLine(fmString(data, "when_to_use"));
      const bodyScan = scanText(body);
      const metaScan = scanText(`${description}\n${whenToUse ?? ""}`);
      const flagged = !bodyScan.ok ? bodyScan : !metaScan.ok ? metaScan : undefined;
      if (flagged) warnings.push(`Skill ${name} was blocked: ${flagged.reason} (${path})`);
      skills.push({
        name,
        description: metaScan.ok ? oneLine(description) : blockedPlaceholder(metaScan.reason),
        whenToUse: metaScan.ok ? whenToUse : undefined,
        dir: skillDir,
        path,
        body: bodyScan.ok ? body : blockedPlaceholder(bodyScan.reason),
        source: dir.source,
        modelInvocable: fmBool(data, "disable-model-invocation") !== true,
        userInvocable: fmBool(data, "user-invocable") ?? true,
      });
    }
  }
  return { skills, warnings };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function optionalLine(text: string | undefined): string | undefined {
  return text === undefined ? undefined : oneLine(text);
}


function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The `<skills>` block for the first message's context: one line per model-invocable skill,
 * "" when there is none. When the full lines don't fit `budget`, later skills drop to their
 * names (keeping room for every remaining name), and past that a "N more skills" note ends it.
 */
export function skillListing(skills: Skill[], budget = SKILL_LISTING_BUDGET): string {
  const listed = skills.filter((s) => s.modelInvocable);
  if (listed.length === 0) return "";
  // Repo and learned skills say so: the model follows their procedure but gives them no more authority than project memory.
  const label = (s: Skill) => (s.source === "project" || s.source === "learned" || s.source === "harness" ? `${s.name} (${s.source})` : s.name);
  const full = listed.map((s) => neutraliseHarnessTags(cap(`- ${label(s)}: ${s.description}${s.whenToUse ? ` — ${s.whenToUse}` : ""}`, MAX_LINE)));
  const short = listed.map((s) => `- ${s.name}`);
  const open = "<skills>";
  const close = "</skills>";
  const noteRoom = `(${listed.length} more skills)`.length + 1;
  // Running cost of names-only lines from i to the end, each with its newline.
  const restShort: number[] = new Array(listed.length + 1).fill(0);
  for (let i = listed.length - 1; i >= 0; i--) restShort[i] = restShort[i + 1]! + short[i]!.length + 1;

  const lines: string[] = [];
  let used = open.length + 1 + close.length;
  for (let i = 0; i < listed.length; i++) {
    const fullCost = full[i]!.length + 1;
    const shortCost = short[i]!.length + 1;
    if (used + fullCost + restShort[i + 1]! <= budget) {
      lines.push(full[i]!);
      used += fullCost;
    } else if (used + restShort[i]! <= budget || used + shortCost + noteRoom <= budget) {
      lines.push(short[i]!);
      used += shortCost;
    } else {
      const more = listed.length - i;
      lines.push(`(${more} more ${more === 1 ? "skill" : "skills"})`);
      break;
    }
  }
  return [open, ...lines, close].join("\n");
}

/** The other files in a skill's folder (relative, sorted, no dotfiles), so the model can Read them. */
async function skillFiles(skill: Skill): Promise<{ files: string[]; more: number }> {
  const all: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(current, { withFileTypes: true })).filter((d) => !d.name.startsWith(".")).map((d) => d.name).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (all.length > MAX_LISTED_FILES * 20) return;
      const full = join(current, name);
      try {
        const info = await stat(full);
        if (info.isDirectory()) {
          if (depth < MAX_FILE_DEPTH) await walk(full, depth + 1);
        } else if (full !== skill.path) {
          all.push(relative(skill.dir, full));
        }
      } catch {
        // a dangling symlink: nothing the model could read
      }
    }
  }
  await walk(skill.dir, 0);
  all.sort();
  return { files: all.slice(0, MAX_LISTED_FILES), more: Math.max(0, all.length - MAX_LISTED_FILES) };
}

/**
 * The text a skill expands to, for the Skill tool and for `/name`: the body inside a `<skill>` tag
 * with the folder placeholders filled in, then the folder's other files, then the arguments.
 */
export async function renderSkill(skill: Skill, args?: string): Promise<string> {
  const body = neutraliseHarnessTags(skill.body.replace(/\$\{(?:TROPOS|CLAUDE)_SKILL_DIR\}/g, () => skill.dir).trim());
  const parts = [`<skill name="${escapeAttr(skill.name)}" source="${skill.source}" dir="${escapeAttr(skill.dir)}">\n${body}\n</skill>`];
  const { files, more } = await skillFiles(skill);
  if (files.length > 0) {
    const tail = more > 0 ? `\n(${more} more ${more === 1 ? "file" : "files"})` : "";
    parts.push(`Other files in ${skill.dir} (Read them when the instructions call for it):\n${files.map((f) => `- ${f}`).join("\n")}${tail}`);
  }
  const trimmed = args?.trim();
  if (trimmed) parts.push(`Arguments: ${neutraliseHarnessTags(trimmed)}`);
  return parts.join("\n\n");
}
