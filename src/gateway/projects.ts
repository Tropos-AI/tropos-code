// src/gateway/projects.ts — the project registry (spec §2.4): the built-in `default` project plus the ones in gateway.json.
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { workspaceDir } from "../paths";
import { resolveToolPath } from "../tools/paths";
import { loadGatewayConfig, newProjectsDirOf, saveGatewayConfig, slugify, uniqueSlug } from "./config";
import { workspaceProblem } from "./policy";
import { ChatRouter } from "./router";
import { UserFacingError } from "./errors";

export interface Project {
  id: string;
  name: string;
  path: string;
  /** The managed default project at ~/.tropos/workspace. */
  builtin?: boolean;
  /** Guests may see and enter it (the built-in project always is). */
  shared?: boolean;
}

/** What a guest may list and switch into: the default workspace and projects the owner shared. */
export function guestVisible(p: Project): boolean {
  return p.builtin === true || p.id === "default" || p.shared === true;
}

export const DEFAULT_PROJECT_ID = "default";
/** The id of the one-off project `tcode gateway --workspace <dir>` makes for a single run. */
export const TEMPORARY_PROJECT_ID = "cwd";

/** A registry change that can't be made; the message is for the owner. */
export class ProjectError extends UserFacingError {}

export const defaultProjectPath = workspaceDir;

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
  return [builtinProject(home), ...config.projects.filter((p) => p.id !== DEFAULT_PROJECT_ID).map((p): Project => ({ id: p.id, name: p.name, path: p.path, ...(p.shared ? { shared: true } : {}) }))];
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
  // Hooks and fsmonitor off: a repo's own config must not run code when Tropos touches it.
  const proc = Bun.spawn([git, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "init", "-q"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
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
  await saveGatewayConfig(home, {
    ...config,
    projects: [...config.projects, { id: project.id, name: project.name, path: project.path }],
    // Adding it by hand undoes an earlier removal.
    removedProjectPaths: config.removedProjectPaths.filter((p) => p !== resolved),
  });
  return project;
}

async function realOr(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

export async function removeProject(home: string, id: string): Promise<Project> {
  if (id === DEFAULT_PROJECT_ID) throw new ProjectError("The default workspace is built in and can't be removed.");
  const config = await loadGatewayConfig(home);
  const found = config.projects.find((p) => p.id === id);
  if (!found) throw new ProjectError(`There is no project "${id}".`);
  await saveGatewayConfig(home, {
    ...config,
    projects: config.projects.filter((p) => p.id !== id),
    // Remembered by real path so running `tcode` there doesn't add it back.
    removedProjectPaths: [...new Set([...config.removedProjectPaths, await realOr(found.path)])],
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

export async function renameProject(home: string, id: string, name: string): Promise<Project> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) throw new ProjectError("A project name is 1 to 80 characters.");
  if (id === DEFAULT_PROJECT_ID) throw new ProjectError("The default workspace is built in and can't be renamed.");
  const config = await loadGatewayConfig(home);
  const found = config.projects.find((p) => p.id === id);
  if (!found) throw new ProjectError(`There is no project "${id}".`);
  await saveGatewayConfig(home, { ...config, projects: config.projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p)) });
  return { id, name: trimmed, path: found.path };
}

/** A new folder under the new-projects directory (default ~/Projects) with `git init`, registered as a project. */
export async function createProject(home: string, name: string, deps: ProjectDeps & { git?: (dir: string) => Promise<void> } = {}): Promise<Project> {
  const trimmed = name.trim();
  if (!trimmed) throw new ProjectError("A project needs a name.");
  const userHome = deps.userHome ?? homedir();
  const folder = /^[\w][\w .-]{0,79}$/.test(trimmed) ? trimmed : slugify(trimmed);
  const dir = join(newProjectsDirOf(await loadGatewayConfig(home), userHome), folder);
  const existing = await readdir(dir).catch(() => null);
  if (existing && existing.length > 0) throw new ProjectError(`${dir} already exists. Want me to add it as a project instead?`);
  await mkdir(dir, { recursive: true });
  try {
    await (deps.git ?? hostGitInit)(dir);
  } catch {
    // No git: the project still works, just without version control.
  }
  return addProject(home, { path: dir, name: trimmed }, { ...deps, userHome });
}

/** The nearest folder at or above `dir` holding a `.git`, never `stopAt` itself or anything above it. */
export async function findRepoRoot(dir: string, stopAt: string): Promise<string | undefined> {
  let cur = dir;
  while (cur !== stopAt) {
    if (await stat(join(cur, ".git")).then(() => true, () => false)) return cur;
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
  return undefined;
}

/**
 * Running `tcode` in a git repo registers its root as a project, once. Returns the project only when it was just
 * added; the home folder, the managed workspace, projects the owner removed and anything unfit are skipped.
 * Never throws: starting `tcode` must not fail because of this.
 */
export async function autoRegisterProject(home: string, cwd: string, deps: { userHome?: string } = {}): Promise<Project | undefined> {
  try {
    const userHome = await realOr(deps.userHome ?? homedir());
    const root = await findRepoRoot(await realpath(cwd), userHome);
    if (!root) return undefined;
    const real = await realpath(root);
    if (workspaceProblem(real, home, userHome)) return undefined;
    const realHome = await realOr(home);
    if (real === realHome || real.startsWith(`${realHome}/`)) return undefined;
    const config = await loadGatewayConfig(home);
    if (config.removedProjectPaths.includes(real)) return undefined;
    if ((await listProjects(home)).some((p) => p.path === real)) return undefined;
    return await addProject(home, { path: real }, { reuse: true, userHome });
  } catch {
    return undefined;
  }
}

/** Lets guests into a project (or shuts them out again). Registering a project never shares it. */
export async function setProjectShared(home: string, id: string, shared: boolean): Promise<Project> {
  if (id === DEFAULT_PROJECT_ID) throw new ProjectError("The default workspace is always open to guests.");
  const config = await loadGatewayConfig(home);
  const found = config.projects.find((p) => p.id === id);
  if (!found) throw new ProjectError(`There is no project "${id}".`);
  await saveGatewayConfig(home, { ...config, projects: config.projects.map((p) => (p.id === id ? { ...p, shared: shared || undefined } : p)) });
  return { id, name: found.name, path: found.path, ...(shared ? { shared } : {}) };
}
