// src/gateway/router.ts — which project each chat is working in (gateway/chats.json), and the pool key that follows.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gatewayDir } from "./config";
import { ProjectError, builtinProject, fileProjectSource, guestProject, guestVisible, GUEST_PROJECT_ID, type Project, type ProjectSource } from "./projects";
import type { ChatSession, SessionProvider } from "./types";

/** The pool's key for a chat in a project: `telegram:123@my-app`. Each (chat, project) pair has its own session. */
export function sessionKey(chatKey: string, projectId: string): string {
  return `${chatKey}@${projectId}`;
}

/** Inverse of `sessionKey`; ids never contain `@`, so the last one splits. */
export function parseSessionKey(key: string): { chatKey: string; projectId: string } | undefined {
  const at = key.lastIndexOf("@");
  return at <= 0 || at === key.length - 1 ? undefined : { chatKey: key.slice(0, at), projectId: key.slice(at + 1) };
}

export interface ChatRouterOptions {
  home: string;
  /** Where projects come from (default: the registry in gateway.json). */
  source?: ProjectSource;
  /** True for a chat that runs as a guest: it only sees the guest workspace and shared projects. */
  isGuest?: (chatKey: string) => Promise<boolean>;
}

export class ChatRouter {
  private readonly source: ProjectSource;
  private readonly path: string;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ChatRouterOptions) {
    this.source = opts.source ?? fileProjectSource(opts.home);
    this.path = join(gatewayDir(opts.home), "chats.json");
  }

  /** The projects this chat may see: all but the guest workspace for the owner; that and the shared ones for a guest. */
  async list(chatKey: string): Promise<Project[]> {
    const projects = (await this.source.list()).filter((p) => p.id !== GUEST_PROJECT_ID);
    return (await this.opts.isGuest?.(chatKey)) ? [guestProject(this.opts.home), ...projects.filter(guestVisible)] : projects;
  }

  /** The chat's project: its own choice while that project still exists, else the default project (a guest's own). */
  async current(chatKey: string): Promise<Project> {
    const guest = (await this.opts.isGuest?.(chatKey)) === true;
    const [chosen, projects] = await Promise.all([this.read().then((m) => m[chatKey]), this.list(chatKey)]);
    const byId = (id: string | undefined) => (id === undefined ? undefined : projects.find((p) => p.id === id));
    if (guest) return byId(chosen) ?? guestProject(this.opts.home);
    return byId(chosen) ?? byId(await this.source.defaultId()) ?? projects[0] ?? builtinProject(this.opts.home);
  }

  async select(chatKey: string, projectId: string): Promise<Project> {
    const project = (await this.list(chatKey)).find((p) => p.id === projectId);
    if (!project) throw new ProjectError(`There is no project "${projectId}".`);
    await this.write(chatKey, projectId);
    return project;
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const json = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!json || typeof json !== "object" || Array.isArray(json)) return {};
      return Object.fromEntries(Object.entries(json).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      return {};
    }
  }

  /** Serialised, so two chats choosing at once don't lose each other's entry. */
  private write(chatKey: string, projectId: string): Promise<void> {
    const run = async () => {
      const map = await this.read();
      if (map[chatKey] === projectId) return;
      map[chatKey] = projectId;
      await mkdir(gatewayDir(this.opts.home), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.path);
    };
    const next = this.saving.then(run, run);
    this.saving = next.catch(() => {});
    return next;
  }
}

/** Opens a chat's session in whichever project the chat is in now, through the pool underneath. */
export class RoutedSessions implements SessionProvider {
  constructor(
    private readonly router: ChatRouter,
    private readonly pool: SessionProvider,
  ) {}

  async open(chatKey: string): Promise<ChatSession> {
    return this.pool.open(sessionKey(chatKey, (await this.router.current(chatKey)).id));
  }

  async close(chatKey: string): Promise<void> {
    await this.pool.close(sessionKey(chatKey, (await this.router.current(chatKey)).id));
  }
}
