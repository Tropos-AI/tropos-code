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
  get(id: string): Promise<{ id: string; name: string } | undefined>;
  defaultId(): Promise<string>;
  /** The project's host, started; its `shutdown` releases what it holds. Called once per project. */
  open(projectId: string): Promise<WebHost>;
}

type ProjectRef = NonNullable<HelloInfo["project"]>;

interface Tab {
  project: ProjectRef;
  host: WebHost;
  /** What the host knows this tab by: the tab's sender, naming the project in every hello. */
  send: Send;
  detach(): void;
  /** A project.select in progress; the tab's requests wait for it, so a prompt sent right after goes to the new one. */
  moving?: Promise<void>;
}

const ref = (p: { id: string; name: string }): ProjectRef => ({ id: p.id, name: p.name });

export class ProjectHosts implements ChatHost {
  /** Opened (or opening) hosts by project id; a failed open is dropped so a later select tries again. */
  private readonly hosts = new Map<string, Promise<WebHost>>();
  /** Open tabs by the sender the server knows them by. */
  private readonly tabs = new Map<Send, Tab>();
  private closed = false;

  private constructor(
    private readonly opts: ProjectHostsOptions,
    private readonly start: { project: ProjectRef; host: WebHost },
  ) {
    this.hosts.set(start.project.id, Promise.resolve(start.host));
  }

  /** Opens the default project's host up front: a broken default project fails here, as the single host did. */
  static async create(opts: ProjectHostsOptions): Promise<ProjectHosts> {
    const id = await opts.defaultId();
    const project = await opts.get(id);
    if (!project) throw new Error(`There is no project "${id}".`);
    return new ProjectHosts(opts, { project: ref(project), host: await opts.open(id) });
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
    if (tab.moving && message.t !== "permission") await tab.moving;
    // The tab's own sender, so the host can leave this tab out of what it echoes back.
    return tab.host.handle(message, tab.send);
  }

  /** Shuts down every host opened so far, including one still opening. */
  async shutdown(opts?: { finalReview?: boolean }): Promise<void> {
    this.closed = true;
    const opened = await Promise.allSettled([...this.hosts.values()]);
    await Promise.all(opened.map((r) => (r.status === "fulfilled" ? r.value.shutdown(opts).catch(() => {}) : undefined)));
  }

  /** One select at a time per tab, in the order sent. */
  private select(tab: Tab, id: number, params: unknown, reply: Send): Promise<void> {
    const move = async (): Promise<RpcMap["project.select"]["result"]> => {
      if (typeof params !== "string") throw new RpcError("Which project?");
      const found = await this.opts.get(params);
      if (!found) throw new RpcError(`There is no project "${params}".`);
      const host = await this.hostFor(found.id);
      // A tab closed meanwhile stays closed.
      if (this.tabs.get(reply) === tab) {
        tab.detach();
        tab.project = ref(found);
        tab.host = host;
        // The new host sends the tab its hello, state and any prompt still waiting for an answer.
        tab.detach = host.attach(tab.send);
      }
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

  private async hostFor(projectId: string): Promise<WebHost> {
    if (this.closed) throw new RpcError("The dashboard is stopping.");
    let opening = this.hosts.get(projectId);
    if (!opening) {
      const fresh = this.opts.open(projectId);
      fresh.catch(() => {
        if (this.hosts.get(projectId) === fresh) this.hosts.delete(projectId);
      });
      this.hosts.set(projectId, fresh);
      opening = fresh;
    }
    const host = await opening;
    // shutdown() stopped it while it opened.
    if (this.closed) throw new RpcError("The dashboard is stopping.");
    return host;
  }
}
