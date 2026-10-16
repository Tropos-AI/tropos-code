// src/gateway/projects.ts — the project registry (spec §2.4): the built-in `default` project plus the ones in gateway.json.
import { existsSync } from "node:fs";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveToolPath } from "../tools/paths";
import { loadGatewayConfig, saveGatewayConfig, uniqueSlug } from "./config";
import { workspaceProblem } from "./policy";
import { ChatRouter } from "./router";
import { UserFacingError } from "./errors";

export interface Project {
  id: string;
  name: string;
  path: string;
  /** The managed default project at ~/.tropos/workspace. */
  builtin?: boolean;
}

export const DEFAULT_PROJECT_ID = "default";
/** The id of the one-off project `tcode gateway --workspace <dir>` makes for a single run. */
export const TEMPORARY_PROJECT_ID = "cwd";

/** A registry change that can't be made; the message is for the owner. */
export class ProjectError extends UserFacingError {}

export const defaultProjectPath = (home: string): string => join(home, "workspace");

const README = `# Tropos workspace

This is the default project of your Tropos gateway: the folder a chat works in until you pick another with /project.
Files the agent creates from Telegram land here. It is a git repository on purpose: the sandbox relies on the .git
folder being there already.

Add your own projects with \`tcode projects add <path>\`.
`;

/** Where a project list comes from; the gateway layers a one-off project over the file registry. */
export interface ProjectSource {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | undefined>;
  defaultId(): Promise<string>;
}

export function builtinProject(home: string): Project {
  return { id: DEFAULT_PROJECT_ID, name: "Default workspace", path: defaultProjectPath(home), builtin: true };
}

/** The built-in project first, then the registered ones. Never creates anything. */
export async function listProjects(home: string): Promise<Project[]> {
  const config = await loadGatewayConfig(home);
  return [builtinProject(home), ...config.projects.filter((p) => p.id !== DEFAULT_PROJECT_ID).map((p): Project => ({ id: p.id, name: p.name, path: p.path }))];
}

export async function getProject(home: string, id: string): Promise<Project | undefined> {
  return (await listProjects(home)).find((p) => p.id === id);
}

/** The id chats start in; falls back to the built-in project when the configured one was removed by hand. */
export async function defaultProjectId(home: string): Promise<string> {
  const [config, projects] = await Promise.all([loadGatewayConfig(home), listProjects(home)]);
  return projects.some((p) => p.id === config.defaultProject) ? config.defaultProject : DEFAULT_PROJECT_ID;
}

export function fileProjectSource(home: string): ProjectSource {
  return { list: () => listProjects(home), get: (id) => getProject(home, id), defaultId: () => defaultProjectId(home) };
}

/** `source` plus one project that lives only for this run, and (optionally) becomes the default. */
export function withTemporaryProject(source: ProjectSource, temporary: Project | undefined): ProjectSource {
  if (!temporary) return source;
  return {
    list: async () => [...(await source.list()).filter((p) => p.id !== temporary.id), temporary],
    get: async (id) => (id === temporary.id ? temporary : source.get(id)),
    defaultId: async () => temporary.id,
  };
}

async function hostGitInit(dir: string): Promise<void> {
  const git = Bun.which("git");
  if (!git) return;
  const proc = Bun.spawn([git, "init", "-q"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), 10_000);
  await proc.exited;
  clearTimeout(timer);
}

export interface EnsureDeps {
  /** Test seam: `git init` in the directory. The default uses the host's git when it has one. */
  git?: (dir: string) => Promise<void>;
}

/**
 * Creates ~/.tropos/workspace on first use: the directory, a `git init` (the sandbox's protection of .git needs one to
 * exist) and a README saying what it is. Existing files are never touched.
 */
export async function ensureDefaultProject(home: string, deps: EnsureDeps = {}): Promise<Project> {
  const project = builtinProject(home);
  await mkdir(project.path, { recursive: true });
  if (!existsSync(join(project.path, ".git"))) {
    try {
      await (deps.git ?? hostGitInit)(project.path);
    } catch {
      // No git, or it failed: the workspace still works, just without the .git protection.
    }
  }
  const readme = join(project.path, "README.md");
  if (!existsSync(readme)) await writeFile(readme, README, { flag: "wx" }).catch(() => {});
  return project;
}

export interface AddProjectInput {
  path: string;
  name?: string;
}
export interface ProjectDeps {
  /** What a relative path resolves against (default: the process's directory). */
  cwd?: string;
  userHome?: string;
  /** A path that is already a project returns that project instead of failing. */
  reuse?: boolean;
}

/** Registers a directory. It must exist and be fit to be mounted into a sandbox (policy.ts decides). */
export async function addProject(home: string, input: AddProjectInput, deps: ProjectDeps = {}): Promise<Project> {
  let resolved: string;
  try {
    resolved = await realpath(resolveToolPath(input.path, deps.cwd ?? process.cwd(), deps.userHome ?? homedir()));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") throw new ProjectError(`${input.path} doesn't exist.`);
    throw new ProjectError(`${input.path} can't be used: ${(e as Error).message}`);
  }
  if (!(await stat(resolved)).isDirectory()) throw new ProjectError(`${resolved} is not a directory.`);
  const unfit = workspaceProblem(resolved, home, deps.userHome ?? homedir());
  if (unfit) throw new ProjectError(unfit);
  const existing = (await listProjects(home)).find((p) => p.path === resolved);
  if (existing) {
    if (deps.reuse) return existing;
    throw new ProjectError(`${resolved} is already the project "${existing.id}".`);
  }
  const config = await loadGatewayConfig(home);
  const name = input.name?.trim() || basename(resolved) || "project";
  const project: Project = { id: uniqueSlug(name, config.projects.map((p) => p.id)), name, path: resolved };
  await saveGatewayConfig(home, { ...config, projects: [...config.projects, { id: project.id, name: project.name, path: project.path }] });
  return project;
}

export async function removeProject(home: string, id: string): Promise<Project> {
  if (id === DEFAULT_PROJECT_ID) throw new ProjectError("The default workspace is built in and can't be removed.");
  const config = await loadGatewayConfig(home);
  const found = config.projects.find((p) => p.id === id);
  if (!found) throw new ProjectError(`There is no project "${id}".`);
  await saveGatewayConfig(home, {
    ...config,
    projects: config.projects.filter((p) => p.id !== id),
    defaultProject: config.defaultProject === id ? DEFAULT_PROJECT_ID : config.defaultProject,
  });
  return { id: found.id, name: found.name, path: found.path };
}

export async function setDefaultProject(home: string, id: string): Promise<Project> {
  const project = await getProject(home, id);
  if (!project) throw new ProjectError(`There is no project "${id}".`);
  const config = await loadGatewayConfig(home);
  await saveGatewayConfig(home, { ...config, defaultProject: id });
  return project;
}

/** The project a chat is working in right now. */
export async function projectForChat(home: string, chatKey: string): Promise<Project> {
  return new ChatRouter({ home }).current(chatKey);
}
