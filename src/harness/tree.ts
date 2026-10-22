// src/harness/tree.ts — the harness as a tree of files (Harness², arXiv 2610.14224): the built-in base, then what was
// adopted for every project (~/.tropos/harness/active), then what was adopted for this one
// (~/.tropos/harness/projects/<key>/active). A layer holds only the files it changes; the rest is inherited.
// Both overlays live under the Tropos home, never in the repository: a repository doesn't configure the agent.
import { createTwoFilesPatch } from "diff";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { errorText } from "../error-text";
import { projectKey, readSmallFileSync } from "../paths";
import { BASE_TREE } from "./base";
import { detectDomain, type Domain } from "./domain";
import { ALWAYS_ON, ALWAYS_ON_CHARS, MAX_FILE_BYTES, MAX_FILES, surfaceKind, type SurfaceKind } from "./surface";

/** Relative path ("/"-separated) → file text. */
export type HarnessTree = ReadonlyMap<string, string>;

/** "candidate" stands in for both adopted layers when a probe runs a harness under test (`--harness-dir`). */
export type LayerName = "base" | "global" | "project" | "candidate";

export interface HarnessLayer {
  name: LayerName;
  /** Where the layer is read from; unset for the built-in base. */
  dir?: string;
  /** The files it holds, sorted. */
  files: string[];
  /** False when the layer was skipped because the tree it made broke a rule. */
  applied: boolean;
  /** Files ignored and rules broken, one line each. */
  problems: string[];
}

export interface Harness {
  tree: HarnessTree;
  /** The always-on files joined, plus the list of scripts when there are any: the session's system prompt. */
  system: string;
  layers: HarnessLayer[];
  /** `skills/` folders of the applied layers, the one that wins first. */
  skillDirs: string[];
  /** `agents/` folders of the applied layers, the one that wins first. */
  agentDirs: string[];
  /** Absolute paths of the scripts in effect. */
  scripts: string[];
  /** The hooks.json in effect, from an adopted layer only: a harness under test never runs hooks. */
  hooksFile?: string;
}

/** Everything the harness keeps: adopted layers, candidates, lab runs and the library. */
export function harnessRoot(home: string): string {
  return join(home, "harness");
}

/** The folder holding a domain's lessons skill (src/harness/library.ts), which sessions in its projects load. */
export function lessonsSkillDir(home: string, domain: Domain): string {
  return join(harnessRoot(home), "library", domain, "skill");
}

export function globalHarnessDir(home: string): string {
  return join(home, "harness", "active");
}

/** `cwd` must be canonical (resolveToolPath), so one project never has two keys. */
export function projectHarnessDir(home: string, cwd: string): string {
  return join(home, "harness", "projects", projectKey(cwd), "active");
}

/** The always-on files in their fixed order, each without trailing whitespace, empty ones left out. */
export function assembleSystem(tree: HarnessTree): string {
  return ALWAYS_ON.map((name) => (tree.get(name) ?? "").trimEnd())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** `top`'s files replace `base`'s; everything `top` doesn't hold is inherited. */
export function overlay(base: HarnessTree, top: HarnessTree): HarnessTree {
  return new Map([...base, ...top]);
}

/** Rules a whole tree must keep; empty when it keeps them all. */
export function validateTree(tree: HarnessTree): string[] {
  const problems: string[] = [];
  if (!(tree.get("system.md") ?? "").trim()) problems.push("system.md is empty");
  const chars = assembleSystem(tree).length;
  if (chars > ALWAYS_ON_CHARS) problems.push(`the always-on files hold ${chars} characters, over the ${ALWAYS_ON_CHARS} limit`);
  return problems;
}

/**
 * The surface files under `dir`. A missing folder is an empty layer. Links, files off the surface, oversized and
 * unreadable files are left out and named in `problems`.
 */
export async function readLayer(dir: string): Promise<{ tree: HarnessTree; problems: string[] }> {
  const tree = new Map<string, string>();
  const problems: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { tree, problems };
    return { tree, problems: [`couldn't read ${dir}: ${errorText(err)}`] };
  }
  const files = entries
    .filter((e) => !e.isDirectory())
    .map((e) => ({ entry: e, path: relative(dir, join(e.parentPath, e.name)).split(sep).join("/") }))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const { entry, path } of files) {
    if (tree.size >= MAX_FILES) {
      problems.push(`more than ${MAX_FILES} files; the rest are ignored`);
      break;
    }
    if (!surfaceKind(path)) {
      problems.push(`${path}: not a harness file; ignored`);
      continue;
    }
    // A link could pull any file on the machine into the system prompt.
    if (!entry.isFile()) {
      problems.push(`${path}: not a plain file; ignored`);
      continue;
    }
    const text = readSmallFileSync(join(dir, path), MAX_FILE_BYTES);
    if (text === null) {
      problems.push(`${path}: unreadable or over ${MAX_FILE_BYTES / 1024} KB; ignored`);
      continue;
    }
    tree.set(path, text);
  }
  return { tree, problems };
}

/** The note that tells the agent which scripts its harness ships; absent without scripts, so the prompt is unchanged. */
export function scriptsSection(scripts: string[]): string {
  if (scripts.length === 0) return "";
  return ["# Scripts", "Helpers that come with your harness; run them with Bash when they fit the task:", ...scripts.map((s) => `- ${s}`)].join("\n");
}

/**
 * The harness a session in `cwd` runs with. Never throws: a layer that breaks a rule is skipped whole, so a broken
 * overlay leaves the agent on the layers below it. With `dir`, that folder is the only overlay (a harness under test).
 */
export async function loadHarness(opts: { home: string; cwd: string; base?: HarnessTree; dir?: string; lessons?: boolean }): Promise<Harness> {
  const base = opts.base ?? BASE_TREE;
  let tree = base;
  /** Which layer folder each file comes from; base files have none. */
  let origin = new Map<string, string>();
  const layers: HarnessLayer[] = [{ name: "base", files: [...base.keys()].sort(), applied: true, problems: [] }];
  const overlays: [LayerName, string][] =
    opts.dir !== undefined
      ? [["candidate", opts.dir]]
      : [
          ["global", globalHarnessDir(opts.home)],
          ["project", projectHarnessDir(opts.home, opts.cwd)],
        ];
  for (const [name, dir] of overlays) {
    const read = await readLayer(dir);
    const next = overlay(tree, read.tree);
    const broken = read.tree.size > 0 ? validateTree(next) : [];
    const applied = broken.length === 0;
    if (applied) {
      tree = next;
      origin = new Map([...origin, ...[...read.tree.keys()].map((path): [string, string] => [path, dir])]);
    }
    layers.push({ name, dir, files: [...read.tree.keys()], applied, problems: [...read.problems, ...broken.map((p) => `${p}; layer skipped`)] });
  }
  const filesOf = (kind: SurfaceKind) => [...tree.keys()].filter((path) => surfaceKind(path) === kind && origin.has(path)).sort();
  // Skills and agents load by folder; the winning layer's folder comes first, and loaders keep the first of each name.
  const foldersOf = (kind: SurfaceKind, folder: string) =>
    [...new Set(filesOf(kind).map((path) => origin.get(path)!))].map((dir) => join(dir, folder));
  const scripts = filesOf("script").map((path) => join(origin.get(path)!, path));
  const hooksDir = opts.dir === undefined ? origin.get("hooks.json") : undefined;
  const lessons = lessonsSkillDir(opts.home, detectDomain(opts.cwd));
  return {
    tree,
    system: [assembleSystem(tree), scriptsSection(scripts)].filter(Boolean).join("\n\n"),
    layers,
    // Then the library's lessons for this kind of project; never in a probe, whose harness must be only what is tested.
    skillDirs: [...orderByLayers(foldersOf("skill", "skills"), overlays), ...(opts.dir === undefined && opts.lessons !== false && existsSync(lessons) ? [lessons] : [])],
    agentDirs: orderByLayers(foldersOf("agent", "agents"), overlays),
    scripts,
    ...(hooksDir ? { hooksFile: join(hooksDir, "hooks.json") } : {}),
  };
}

/** Folders under the overlays, the later (winning) overlay first. */
function orderByLayers(folders: string[], overlays: [LayerName, string][]): string[] {
  const rank = (folder: string) => overlays.findIndex(([, dir]) => folder.startsWith(dir));
  return [...folders].sort((a, b) => rank(b) - rank(a));
}

/** One line per problem, for the warnings a session prints at start. */
export function harnessWarnings(harness: Harness): string[] {
  return harness.layers.flatMap((layer) => layer.problems.map((p) => `harness (${layer.name}): ${p}`));
}

export interface TreeChange {
  path: string;
  change: "added" | "changed" | "removed";
}

export function diffTrees(from: HarnessTree, to: HarnessTree): TreeChange[] {
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  return paths.flatMap((path): TreeChange[] => {
    const before = from.get(path);
    const after = to.get(path);
    if (before === after) return [];
    return [{ path, change: before === undefined ? "added" : after === undefined ? "removed" : "changed" }];
  });
}

/** A unified patch per changed file, from `from` to `to`. */
export function renderTreeDiff(from: HarnessTree, to: HarnessTree): string {
  return diffTrees(from, to)
    .map(({ path }) => createTwoFilesPatch(`a/${path}`, `b/${path}`, from.get(path) ?? "", to.get(path) ?? "", "", "", { context: 3 }))
    .join("");
}
