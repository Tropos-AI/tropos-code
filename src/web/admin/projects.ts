// src/web/admin/projects.ts — `projects.*`: the project registry and the folder picker.
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { addProject, defaultProjectId, listProjects, removeProject, renameProject, setDefaultProject, type Project } from "../../gateway/projects";
import type { BrowseEntry, ProjectView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { messageOf } from "./util";

const MAX_ENTRIES = 500;

const isGitRepo = (dir: string): Promise<boolean> =>
  lstat(join(dir, ".git")).then(
    () => true,
    () => false,
  );

/** Registry errors are written for the owner, so they are shown as they are. */
async function shown<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw err instanceof AdminError ? err : new AdminError(messageOf(err));
  }
}

export function projectsHandlers(ctx: AdminContext): AdminHandlers {
  const views = async (): Promise<ProjectView[]> => {
    const [projects, defaultId] = await Promise.all([listProjects(ctx.home), defaultProjectId(ctx.home)]);
    return Promise.all(projects.map(async (p: Project): Promise<ProjectView> => ({ id: p.id, name: p.name, path: p.path, ...(p.builtin ? { builtin: true } : {}), isDefault: p.id === defaultId, gitRepo: await isGitRepo(p.path) })));
  };
  const reload = async () => {
    await ctx.gateway?.reload().catch(() => undefined);
  };
  const projectDeps = { cwd: ctx.userHome, userHome: ctx.userHome };

  return {
    "projects.list": () => shown(views),
    "projects.add": (p) =>
      shown(async () => {
        if (typeof p?.path !== "string" || !p.path.trim()) throw new AdminError("Choose a folder.");
        const added = await addProject(ctx.home, { path: p.path.trim(), name: typeof p.name === "string" ? p.name : undefined }, projectDeps);
        await reload();
        return (await views()).find((v) => v.id === added.id)!;
      }),
    "projects.remove": (p) =>
      shown(async () => {
        if (typeof p?.id !== "string") throw new AdminError("Say which project to remove.");
        await removeProject(ctx.home, p.id);
        await reload();
        return { removed: true };
      }),
    "projects.setDefault": (p) =>
      shown(async () => {
        if (typeof p?.id !== "string") throw new AdminError("Say which project to make the default.");
        await setDefaultProject(ctx.home, p.id);
        await reload();
        return views();
      }),
    "projects.rename": (p) =>
      shown(async () => {
        if (typeof p?.id !== "string") throw new AdminError("Say which project to rename.");
        if (typeof p.name !== "string") throw new AdminError("Give the project a name.");
        const renamed = await renameProject(ctx.home, p.id, p.name);
        await reload();
        return (await views()).find((v) => v.id === renamed.id)!;
      }),
    "projects.browse": (p) =>
      shown(async () => {
        const asked = typeof p?.path === "string" && p.path.trim() ? p.path.trim() : ctx.userHome;
        let path: string;
        try {
          path = await realpath(isAbsolute(asked) ? asked : resolve(ctx.userHome, asked));
        } catch {
          throw new AdminError(`${asked} doesn't exist.`);
        }
        if (!(await stat(path)).isDirectory()) throw new AdminError(`${path} is a file, not a folder.`);
        let names: string[];
        try {
          names = await readdir(path);
        } catch {
          throw new AdminError(`${path} can't be read.`);
        }
        // lstat: a symlink is not listed as a folder, so the picker never leads somewhere the listing doesn't show.
        const found = await Promise.all(
          names
            .filter((n) => !n.startsWith("."))
            .map(async (name): Promise<BrowseEntry | null> => {
              const full = join(path, name);
              const info = await lstat(full).catch(() => null);
              return info?.isDirectory() ? { name, path: full, isGitRepo: await isGitRepo(full) } : null;
            }),
        );
        const entries = found.filter((e): e is BrowseEntry => e !== null).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_ENTRIES);
        const parent = dirname(path);
        return { path, parent: parent === path ? null : parent, entries };
      }),
  };
}
