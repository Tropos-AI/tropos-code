// src/tools/setup/skill-install.ts — TroposSetup's `skill.install`: a SKILL.md from a URL, or a skill's folder from a git
// repository, into the owner's skills. A skill is prompt text later sessions follow, so every file is put through the
// threat scan in its strict form (the one for text that arrives from outside) before anything is written, and the
// writes go through SkillManage's own code, which checks again and records each file in the ledger.
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fmString, parseFrontmatter } from "../../extensions/frontmatter";
import { resolveLayoutPath } from "../../home/layout";
import { fetchBytes } from "../../install/fetch";
import type { Ledger } from "../../learning/ledger";
import { scanText } from "../../learning/threats";
import { manageSkill, MAX_SKILL_FILE_CHARS } from "../../memory/skill-manage";
import type { Actor } from "../types";
import { fetchTree, folderIn } from "./fetch-tree";
import { guardedFetch, HostRefused, hostProblem, parseSource, type Resolve } from "./sources";

export interface SkillInstallDeps {
  home: string;
  ledger?: Ledger;
  actor: Actor;
  fetch?: typeof fetch;
  cloneEnv?: NodeJS.ProcessEnv;
  /** Looks each host up before it is fetched from or cloned; the system resolver by default. */
  resolve?: Resolve;
}

export interface SkillRequest {
  /** A SKILL.md URL (a GitHub file link works), a git repository, or a local folder. */
  source: string;
  /** The skill's name; its folder's (or the frontmatter's) by default. */
  name?: string;
  /** The skill's folder inside the repository. */
  subdir?: string;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_FILES = 50;
const MAX_REPO_BYTES = 20 * 1024 * 1024;

/** The skill's files, path → text, SKILL.md first. Throws when one isn't text, is too big, or there are too many. */
async function readFolder(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (at: string, rel: string): Promise<void> => {
    for (const name of (await readdir(at)).sort()) {
      const path = join(at, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path, relPath);
      else if (info.isFile()) {
        if (files.size >= MAX_FILES) throw new Error(`The skill has more than ${MAX_FILES} files; that is more than a skill should be.`);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
        } catch {
          throw new Error(`The skill holds ${relPath}, which isn't text; I only install text files with a skill.`);
        }
        if (text.length > MAX_SKILL_FILE_CHARS) throw new Error(`${relPath} is over ${MAX_SKILL_FILE_CHARS.toLocaleString("en-US")} characters.`);
        files.set(relPath, text);
      }
    }
  };
  await walk(dir, "");
  if (!files.has("SKILL.md")) throw new Error("That folder has no SKILL.md, so it isn't a skill. Name the folder that holds it.");
  return new Map([["SKILL.md", files.get("SKILL.md")!], ...[...files].filter(([k]) => k !== "SKILL.md")]);
}

/** The folder name a source suggests: the SKILL.md's folder, the subfolder, or the repository. */
function folderName(source: string, subdir: string | undefined): string {
  const path = (subdir ?? new URL(source, "file:///").pathname).replace(/\/+$/, "");
  const last = basename(path).replace(/\.git$/, "");
  if (/^skill\.md$/i.test(last)) return basename(path.slice(0, -last.length - 1));
  return last.replace(/\.md$/i, "");
}

/** Installs the skill and returns its name, folder and files. Throws a readable Error; a refusal writes nothing. */
export async function installSkill(deps: SkillInstallDeps, req: SkillRequest): Promise<{ name: string; dir: string; files: string[] }> {
  const source = parseSource(req.source, req.subdir);
  if ("problem" in source) throw new Error(source.problem);
  let files: Map<string, string>;
  let suggested: string;
  if (source.kind === "file") {
    const refused = await hostProblem(new URL(source.url), deps.resolve);
    if (refused) throw new Error(refused);
    const bytes = await fetchBytes(source.url, { maxBytes: MAX_SKILL_FILE_CHARS * 4, timeoutMs: 30_000, fetch: guardedFetch(deps.fetch ?? fetch, deps.resolve) }).catch((e: unknown) => {
      throw e instanceof Error && e.cause instanceof HostRefused ? e.cause : e;
    });
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${source.url} isn't a text file.`);
    }
    if (text.length > MAX_SKILL_FILE_CHARS) throw new Error(`That file is over ${MAX_SKILL_FILE_CHARS.toLocaleString("en-US")} characters.`);
    files = new Map([["SKILL.md", text]]);
    suggested = folderName(source.url, undefined);
  } else {
    const staging = await mkdtemp(join(tmpdir(), "tropos-skill-"));
    try {
      const tree = join(staging, "tree");
      await fetchTree(source, tree, { maxBytes: MAX_REPO_BYTES, ...(deps.cloneEnv ? { cloneEnv: deps.cloneEnv } : {}), ...(deps.resolve ? { resolve: deps.resolve } : {}) });
      const subdir = source.kind === "local" ? req.subdir : source.subdir;
      files = await readFolder(await folderIn(tree, subdir));
      suggested = folderName(source.kind === "local" ? source.path : source.url, subdir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  const skill = files.get("SKILL.md")!;
  const fmName = fmString(parseFrontmatter(skill).data, "name");
  const name = req.name ?? (fmName && NAME.test(fmName) ? fmName : suggested);
  if (name.length > 64 || !NAME.test(name)) throw new Error(`"${name.slice(0, 64)}" can't be a skill's name: use lowercase letters, digits and single hyphens, and give it as the name.`);
  const skillsDir = resolveLayoutPath(deps.home, "skills");
  if (existsSync(join(skillsDir, name))) throw new Error(`You already have a skill named ${name}. Give this one another name, or delete that one first.`);
  // Everything is checked before the first write, so a refusal leaves no half-installed skill.
  for (const [rel, text] of files) {
    const scan = scanText(text, { strict: true });
    if (!scan.ok) throw new Error(`Refused: ${rel} looks unsafe (${scan.reason}). Skills are loaded as instructions in later sessions, so I don't install one with injected instructions, secret exfiltration, fetch-and-run lines or hidden characters.`);
  }

  const opts = { home: deps.home, dir: skillsDir, ...(deps.ledger ? { ledger: deps.ledger } : {}) };
  const failed = (out: { content: unknown }): string => (typeof out.content === "string" ? out.content : "it couldn't be written");
  const created = await manageSkill(opts, { action: "create", name, content: skill }, deps.actor);
  if (created.isError) throw new Error(failed(created));
  for (const [rel, text] of files) {
    if (rel === "SKILL.md") continue;
    const wrote = await manageSkill(opts, { action: "write_file", name, file_path: rel, file_content: text }, deps.actor);
    if (wrote.isError) {
      await rm(join(skillsDir, name), { recursive: true, force: true });
      throw new Error(`${rel}: ${failed(wrote)}`);
    }
  }
  return { name, dir: join(skillsDir, name), files: [...files.keys()] };
}
