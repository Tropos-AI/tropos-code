// src/web/project-hosts.ts — the background service's dashboard chat: one WebHost per project, one project per tab.
// A tab starts in the default project and moves with `project.select`; everything else it sends goes to its host.
import { errorText } from "../error-text";
import { RpcError, type Send, type WebHost } from "./host";
import type { ClientMessage, HelloInfo, RpcMap } from "./protocol";

/** What the web server serves tabs from: one WebHost (`tcode web`) or a ProjectHosts (the gateway). */
export interface ChatHost {
  attach(send: Send): () => void;
  handle(message: ClientMessage, reply: Send): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ProjectHostsOptions {
  /** `path`, when given, tells a project that was removed and re-added under the same id from the one a host is on. */
  get(id: string): Promise<{ id: string; name: string; path?: string } | undefined>;
  defaultId(): Promise<string>;
  /** The project's host, started; its `shutdown` releases what it holds. Called once per project. */
  open(projectId: string): Promise<WebHost>;
}

type ProjectRef = NonNullable<HelloInfo["project"]>;
type Found = { id: string; name: string; path?: string };

interface Opened {
  opening: Promise<WebHost>;
  /** The project's path when it was opened. */
  path?: string;
}

interface Tab {
  project: ProjectRef;
  host: WebHost;
  /** What the host knows this tab by: the tab's sender, naming the project in every hello. */
  send: Send;
  detach(): void;
  /**
   * A project.select in progress; the tab's requests wait for it, so a prompt sent right after goes to the new one.
   * Permission answers and interrupt don't: they act on the host the tab is still on, and must not hang on an open.
   */
  moving?: Promise<void>;
}

const ref = (p: Found): ProjectRef => ({ id: p.id, name: p.name });

export class ProjectHosts implements ChatHost {
  /** Opened (or opening) hosts by project id; a failed open is dropped so a later select tries again. */
  private readonly hosts = new Map<string, Opened>();
  /** Open tabs by the sender the server knows them by. */
  private readonly tabs = new Map<Send, Tab>();
  private closed = false;

  /** Where new tabs start: the default project as last read (create, refresh). */
  private start!: { project: ProjectRef; host: WebHost };

  private constructor(private readonly opts: ProjectHostsOptions) {}

  /** Opens the default project's host up front: a broken default project fails here, as the single host did. */
  static async create(opts: ProjectHostsOptions): Promise<ProjectHosts> {
    const hosts = new ProjectHosts(opts);
    await hosts.readDefault();
    return hosts;
  }

  /**
   * After the projects changed (a reload): a host whose project was removed, or now has another path under the same
   * id, is closed and its tabs move to the default project, which is read again for them and for new tabs.
   */
  async refresh(): Promise<void> {
    if (this.closed) return;
    const stale: string[] = [];
    for (const [id, opened] of [...this.hosts]) {
      const now = await this.opts.get(id);
      if (!now || now.path !== opened.path) stale.push(id);
    }
    await this.evict(stale);
  }

  /** Closes the project's host; its tabs move to the (re-read) default project. */
  close(projectId: string): Promise<void> {
    return this.evict([projectId]);
  }

  attach(send: Send): () => void {
    const tab: Tab = {
      project: this.start.project,
      host: this.start.host,
      send: (message) => send(message.t === "hello" ? { ...message, server: { ...message.server, project: tab.project } } : message),
      detach: () => {},
    };
    this.tabs.set(send, tab);
    tab.detach = tab.host.attach(tab.send);
    return () => {
      if (this.tabs.get(send) === tab) this.tabs.delete(send);
      tab.detach();
    };
  }

  async handle(message: ClientMessage, reply: Send): Promise<void> {
    const tab = this.tabs.get(reply);
    if (!tab) return this.start.host.handle(message, reply);
    if (message.t === "rpc" && message.method === "project.select") return this.select(tab, message.id, message.params, reply);
    // A permission answer goes at once: the prompt it answers is on the host the tab is still attached to.
    if (tab.moving && message.t !== "permission" && !(message.t === "rpc" && message.method === "interrupt")) await tab.moving;
    // The tab's own sender, so the host can leave this tab out of what it echoes back.
    return tab.host.handle(message, tab.send);
  }

  /** A notice to every tab, through the hosts they are on. */
  notify(level: "info" | "warn" | "error", text: string): void {
    for (const host of new Set([this.start.host, ...[...this.tabs.values()].map((t) => t.host)])) host.notify(level, text);
  }

  /** Shuts down every host opened so far, including one still opening. */
  async shutdown(opts?: { finalReview?: boolean }): Promise<void> {
    this.closed = true;
    const opened = await Promise.allSettled([...this.hosts.values()].map((o) => o.opening));
    await Promise.all(opened.map((r) => (r.status === "fulfilled" ? r.value.shutdown(opts).catch(() => {}) : undefined)));
  }

  /** One select at a time per tab, in the order sent. */
  private select(tab: Tab, id: number, params: unknown, reply: Send): Promise<void> {
    const move = async (): Promise<RpcMap["project.select"]["result"]> => {
      if (typeof params !== "string") throw new RpcError("Which project?");
      const found = await this.opts.get(params);
      if (!found) throw new RpcError(`There is no project "${params}".`);
      // Removed and re-added elsewhere under the same id since its host opened (without a reload): not that host.
      const cached = this.hosts.get(found.id);
      if (cached && cached.path !== found.path) await this.close(found.id);
      const host = await this.hostFor(found);
      // A tab closed meanwhile stays closed.
      if (this.tabs.get(reply) === tab) this.move(tab, ref(found), host);
      return { ...host.hello(), project: ref(found) };
    };
    const done = (tab.moving ?? Promise.resolve()).then(move).then(
      (result) => reply({ t: "rpc_result", id, ok: true, result }),
      (err: unknown) => reply({ t: "rpc_result", id, ok: false, error: errorText(err) }),
    );
    tab.moving = done;
    void done.then(() => {
      if (tab.moving === done) tab.moving = undefined;
    });
    return done;
  }

  /** The new host sends the tab its hello, state and any prompt still waiting for an answer. */
  private move(tab: Tab, project: ProjectRef, host: WebHost): void {
    tab.detach();
    tab.project = project;
    tab.host = host;
    tab.detach = host.attach(tab.send);
  }

  private async readDefault(): Promise<void> {
    const id = await this.opts.defaultId();
    const project = await this.opts.get(id);
    if (!project) throw new Error(`There is no project "${id}".`);
    this.start = { project: ref(project), host: await this.hostFor(project) };
  }

  /**
   * Drops the hosts first, so the default read next opens afresh when it was one of them; then moves their tabs there
   * and shuts them down. When the default can't be opened, nothing is closed: the tabs would have nowhere to go.
   */
  private async evict(ids: string[]): Promise<void> {
    const gone = ids.flatMap((id) => {
      const opened = this.hosts.get(id);
      if (!opened) return [];
      this.hosts.delete(id);
      return [[id, opened] as const];
    });
    try {
      await this.readDefault();
    } catch (e) {
      for (const [id, opened] of gone) if (!this.hosts.has(id)) this.hosts.set(id, opened);
      throw e;
    }
    for (const [, opened] of gone) {
      const host = await opened.opening.catch(() => undefined);
      if (!host) continue;
      for (const tab of this.tabs.values()) if (tab.host === host) this.move(tab, this.start.project, this.start.host);
      // Its project is gone: the conversation ends here, without holding up the reload for a final review.
      await host.shutdown({ finalReview: false }).catch(() => {});
    }
  }

  private async hostFor(project: Found): Promise<WebHost> {
    if (this.closed) throw new RpcError("The dashboard is stopping.");
    let opened = this.hosts.get(project.id);
    if (!opened) {
      const fresh: Opened = { opening: this.opts.open(project.id), path: project.path };
      fresh.opening.catch(() => {
        if (this.hosts.get(project.id) === fresh) this.hosts.delete(project.id);
      });
      this.hosts.set(project.id, fresh);
      opened = fresh;
    }
    const host = await opened.opening;
    // shutdown() stopped it while it opened.
    if (this.closed) throw new RpcError("The dashboard is stopping.");
    // Evicted while it opened (its project changed): open the project as it is now.
    if (this.hosts.get(project.id) !== opened) {
      const now = await this.opts.get(project.id);
      if (!now) throw new RpcError(`There is no project "${project.id}".`);
      return this.hostFor(now);
    }
    return host;
  }
}
