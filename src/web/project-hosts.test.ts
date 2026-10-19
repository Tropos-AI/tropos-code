// src/web/project-hosts.test.ts
import { describe, expect, test } from "bun:test";
import type { Send, WebHost } from "./host";
import { ProjectHosts } from "./project-hosts";
import type { ClientMessage, HelloInfo, ServerMessage } from "./protocol";

const PROJECTS: Record<string, { id: string; name: string; path: string }> = {
  default: { id: "default", name: "Default workspace", path: "/w/default" },
  app: { id: "app", name: "App", path: "/w/app" },
  site: { id: "site", name: "Site", path: "/w/site" },
};

/** A WebHost-shaped fake that records what reaches it. */
function fakeHost(projectId: string) {
  const attached: Send[] = [];
  const detached: Send[] = [];
  const handled: Array<{ message: ClientMessage; reply: Send }> = [];
  let shutdowns = 0;
  const hello = (): HelloInfo => ({ version: "1", cwd: `/w/${projectId}`, sessionId: `s-${projectId}`, modes: ["default"], commands: [], history: [] });
  const host = {
    hello,
    attach(send: Send) {
      attached.push(send);
      send({ t: "hello", server: hello() });
      send({ t: "state", state: { model: "m", effort: "medium", mode: "default", busy: false, contextTokens: 0, turns: 0 } as never });
      return () => void detached.push(send);
    },
    async handle(message: ClientMessage, reply: Send) {
      handled.push({ message, reply });
      if (message.t === "rpc") reply({ t: "rpc_result", id: message.id, ok: true, result: projectId });
    },
    async shutdown() {
      shutdowns++;
    },
  };
  return { host: host as unknown as WebHost, attached, detached, handled, shutdowns: () => shutdowns };
}

async function setup() {
  const hosts = new Map<string, ReturnType<typeof fakeHost>>();
  const opened: string[] = [];
  const router = await ProjectHosts.create({
    get: async (id) => PROJECTS[id],
    defaultId: async () => "default",
    open: async (id) => {
      opened.push(id);
      const h = fakeHost(id);
      hosts.set(id, h);
      return h.host;
    },
  });
  return { router, hosts, opened };
}

function tab() {
  const seen: ServerMessage[] = [];
  const send: Send = (m) => void seen.push(m);
  const rpc = (router: ProjectHosts, id: number, method: string, params?: unknown) => router.handle({ t: "rpc", id, method: method as never, params }, send);
  const result = (id: number) => seen.find((m) => m.t === "rpc_result" && m.id === id);
  return { seen, send, rpc, result };
}

const hellos = (seen: ServerMessage[]) => seen.flatMap((m) => (m.t === "hello" ? [m.server] : []));

describe("ProjectHosts", () => {
  test("a new tab is in the default project and its hello names it", async () => {
    const { router, opened, hosts } = await setup();
    // Opened up front, before any tab: a broken default project fails at start, as before.
    expect(opened).toEqual(["default"]);
    const a = tab();
    router.attach(a.send);
    expect(hosts.get("default")!.attached).toHaveLength(1);
    expect(hellos(a.seen)).toEqual([expect.objectContaining({ sessionId: "s-default", project: { id: "default", name: "Default workspace" } })]);
    // Only the id and name travel, never the path.
    expect(hellos(a.seen)[0]!.project).toEqual({ id: "default", name: "Default workspace" });
    expect(a.seen.map((m) => m.t)).toEqual(["hello", "state"]);
  });

  test("project.select moves only that tab, opens each project's host once, and replies with the new hello", async () => {
    const { router, opened, hosts } = await setup();
    const a = tab();
    const b = tab();
    router.attach(a.send);
    router.attach(b.send);
    await a.rpc(router, 1, "project.select", "app");
    expect(opened).toEqual(["default", "app"]);
    // The tab left the default host and joined the app's, which sent it hello and state.
    expect(hosts.get("default")!.detached).toHaveLength(1);
    expect(hosts.get("app")!.attached).toHaveLength(1);
    expect(hellos(a.seen).at(-1)).toMatchObject({ sessionId: "s-app", project: { id: "app", name: "App" } });
    expect(a.result(1)).toEqual({ t: "rpc_result", id: 1, ok: true, result: expect.objectContaining({ sessionId: "s-app", project: { id: "app", name: "App" } }) });
    // The other tab stayed where it was.
    expect(hellos(b.seen)).toHaveLength(1);
    expect(hosts.get("default")!.attached).toHaveLength(2);

    // A second tab choosing the same project reuses its host; going back reuses the default's.
    await b.rpc(router, 1, "project.select", "app");
    await a.rpc(router, 2, "project.select", "default");
    expect(opened).toEqual(["default", "app"]);
    expect(hellos(a.seen).at(-1)).toMatchObject({ sessionId: "s-default", project: { id: "default" } });
    expect(hellos(b.seen).at(-1)).toMatchObject({ sessionId: "s-app", project: { id: "app" } });
  });

  test("tabs choosing the same project at once still open its host once", async () => {
    const { router, opened } = await setup();
    const a = tab();
    const b = tab();
    router.attach(a.send);
    router.attach(b.send);
    await Promise.all([a.rpc(router, 1, "project.select", "site"), b.rpc(router, 1, "project.select", "site")]);
    expect(opened).toEqual(["default", "site"]);
  });

  test("an unknown project is an RPC error and the tab stays", async () => {
    const { router, opened, hosts } = await setup();
    const a = tab();
    router.attach(a.send);
    await a.rpc(router, 1, "project.select", "nope");
    expect(a.result(1)).toEqual({ t: "rpc_result", id: 1, ok: false, error: 'There is no project "nope".' });
    await a.rpc(router, 2, "project.select", 42);
    expect(a.result(2)).toMatchObject({ ok: false });
    expect(opened).toEqual(["default"]);
    expect(hosts.get("default")!.detached).toEqual([]);
    await a.rpc(router, 3, "sessions");
    expect(a.result(3)).toMatchObject({ ok: true, result: "default" });
  });

  test("a project whose host can't open is an RPC error and the tab stays", async () => {
    let fail = true;
    const router = await ProjectHosts.create({
      get: async (id) => PROJECTS[id],
      defaultId: async () => "default",
      open: async (id) => {
        if (id === "app" && fail) throw new Error('Project "App" can\'t be used: it is gone');
        return fakeHost(id).host;
      },
    });
    const a = tab();
    router.attach(a.send);
    await a.rpc(router, 1, "project.select", "app");
    expect(a.result(1)).toEqual({ t: "rpc_result", id: 1, ok: false, error: 'Project "App" can\'t be used: it is gone' });
    expect(hellos(a.seen)).toHaveLength(1);
    // Not cached: once fixed, the next try opens it.
    fail = false;
    await a.rpc(router, 2, "project.select", "app");
    expect(a.result(2)).toMatchObject({ ok: true });
  });

  test("prompts and permission answers go to the tab's current project", async () => {
    const { router, hosts } = await setup();
    const a = tab();
    const b = tab();
    router.attach(a.send);
    router.attach(b.send);
    await a.rpc(router, 1, "project.select", "app");
    await a.rpc(router, 2, "prompt", { text: "hi" });
    await router.handle({ t: "permission", id: 7, answer: { kind: "allow" } }, a.send);
    await b.rpc(router, 1, "prompt", { text: "there" });
    const app = hosts.get("app")!;
    const def = hosts.get("default")!;
    expect(app.handled.map((h) => h.message.t)).toEqual(["rpc", "permission"]);
    expect(def.handled.map((h) => h.message)).toEqual([{ t: "rpc", id: 1, method: "prompt", params: { text: "there" } }]);
    // The host knows the tab by the sender it attached, so it can leave the tab out of its own echo.
    expect(app.handled[0]!.reply).toBe(app.attached[0]!);
    expect(a.result(2)).toMatchObject({ ok: true, result: "app" });
    // A hello the host broadcasts later (resume, clear, a reload) also names the project.
    app.attached[0]!({ t: "hello", server: app.host.hello() });
    expect(hellos(a.seen).at(-1)).toMatchObject({ project: { id: "app", name: "App" } });
  });

  test("a prompt sent while the tab is moving goes to the project it moves to", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hosts = new Map<string, ReturnType<typeof fakeHost>>();
    const router = await ProjectHosts.create({
      get: async (id) => PROJECTS[id],
      defaultId: async () => "default",
      open: async (id) => {
        if (id === "app") await gate;
        const h = fakeHost(id);
        hosts.set(id, h);
        return h.host;
      },
    });
    const a = tab();
    router.attach(a.send);
    const moving = a.rpc(router, 1, "project.select", "app");
    const prompt = a.rpc(router, 2, "prompt", { text: "hi" });
    release();
    await Promise.all([moving, prompt]);
    expect(hosts.get("default")!.handled).toEqual([]);
    expect(hosts.get("app")!.handled.map((h) => h.message)).toEqual([{ t: "rpc", id: 2, method: "prompt", params: { text: "hi" } }]);
  });

  test("a closed tab leaves its host", async () => {
    const { router, hosts } = await setup();
    const a = tab();
    const detach = router.attach(a.send);
    await a.rpc(router, 1, "project.select", "app");
    detach();
    expect(hosts.get("app")!.detached).toHaveLength(1);
  });

  test("shutdown closes every opened host", async () => {
    const { router, hosts } = await setup();
    const a = tab();
    router.attach(a.send);
    await a.rpc(router, 1, "project.select", "app");
    await a.rpc(router, 2, "project.select", "site");
    await router.shutdown();
    expect([...hosts.values()].map((h) => h.shutdowns())).toEqual([1, 1, 1]);
    // Nothing opens afterwards.
    await a.rpc(router, 3, "project.select", "default");
    expect(a.result(3)).toMatchObject({ ok: false });
  });
});

describe("ProjectHosts when projects change", () => {
  /** Projects that tests edit, as the registry would after a remove, an add or a new default. */
  async function world() {
    const projects = new Map(Object.values(PROJECTS).map((p) => [p.id, { ...p }]));
    let defaultId = "default";
    const opened: Array<{ id: string; path: string; fake: ReturnType<typeof fakeHost> }> = [];
    const router = await ProjectHosts.create({
      get: async (id) => projects.get(id),
      defaultId: async () => defaultId,
      open: async (id) => {
        const fake = fakeHost(id);
        opened.push({ id, path: projects.get(id)!.path, fake });
        return fake.host;
      },
    });
    const setDefault = (id: string) => void (defaultId = id);
    return { router, projects, opened, setDefault };
  }

  test("a removed project's tabs move to the default project at the next refresh, and its host is shut down", async () => {
    const { router, projects, opened } = await world();
    const a = tab();
    router.attach(a.send);
    await a.rpc(router, 1, "project.select", "app");
    projects.delete("app");
    await router.refresh();
    expect(hellos(a.seen).at(-1)).toMatchObject({ sessionId: "s-default", project: { id: "default" } });
    const app = opened.find((o) => o.id === "app")!.fake;
    expect(app.shutdowns()).toBe(1);
    expect(app.detached).toHaveLength(1);
    await a.rpc(router, 2, "prompt", { text: "hi" });
    expect(opened[0]!.fake.handled.map((h) => h.message.t)).toEqual(["rpc"]);
  });

  test("a project removed and re-added at a new path under the same id opens the new path, with or without a refresh", async () => {
    const { router, projects, opened } = await world();
    const a = tab();
    router.attach(a.send);
    await a.rpc(router, 1, "project.select", "app");
    await a.rpc(router, 2, "project.select", "default");
    projects.set("app", { id: "app", name: "App", path: "/elsewhere/app" });
    // No refresh (`tcode projects add` doesn't reload the gateway): selecting it notices the new path.
    await a.rpc(router, 3, "project.select", "app");
    expect(opened.filter((o) => o.id === "app").map((o) => o.path)).toEqual(["/w/app", "/elsewhere/app"]);
    expect(opened[1]!.fake.shutdowns()).toBe(1);
    expect(hellos(a.seen).at(-1)).toMatchObject({ project: { id: "app" } });
    // And a refresh after another move closes the old host and leaves the tab in the default.
    projects.set("app", { id: "app", name: "App", path: "/third/app" });
    await router.refresh();
    expect(opened[2]!.fake.shutdowns()).toBe(1);
    expect(hellos(a.seen).at(-1)).toMatchObject({ project: { id: "default" } });
  });

  test("when the default project is removed, its tabs and new tabs land on the new default", async () => {
    const { router, projects, setDefault, opened } = await world();
    const a = tab();
    router.attach(a.send);
    projects.delete("default");
    setDefault("site");
    await router.refresh();
    expect(hellos(a.seen).at(-1)).toMatchObject({ sessionId: "s-site", project: { id: "site", name: "Site" } });
    expect(opened[0]!.fake.shutdowns()).toBe(1);
    const b = tab();
    router.attach(b.send);
    expect(hellos(b.seen)).toEqual([expect.objectContaining({ project: { id: "site", name: "Site" } })]);
  });

  test("a new default (the old one still there) applies to new tabs; open tabs stay", async () => {
    const { router, setDefault } = await world();
    const a = tab();
    router.attach(a.send);
    setDefault("app");
    await router.refresh();
    expect(hellos(a.seen)).toHaveLength(1);
    const b = tab();
    router.attach(b.send);
    expect(hellos(b.seen)[0]).toMatchObject({ project: { id: "app" } });
  });

  test("interrupt and permission answers aren't held up by a move that hangs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hosts = new Map<string, ReturnType<typeof fakeHost>>();
    const router = await ProjectHosts.create({
      get: async (id) => PROJECTS[id],
      defaultId: async () => "default",
      open: async (id) => {
        if (id === "app") await gate;
        const h = fakeHost(id);
        hosts.set(id, h);
        return h.host;
      },
    });
    const a = tab();
    router.attach(a.send);
    const moving = a.rpc(router, 1, "project.select", "app");
    await a.rpc(router, 2, "interrupt");
    await router.handle({ t: "permission", id: 5, answer: { kind: "deny" } }, a.send);
    expect(hosts.get("default")!.handled.map((h) => h.message.t)).toEqual(["rpc", "permission"]);
    release();
    await moving;
  });

  test("notify reaches every opened project's host once", async () => {
    const { router, hosts } = await setup();
    const a = tab();
    router.attach(a.send);
    await a.rpc(router, 1, "project.select", "app");
    const told: string[] = [];
    for (const [id, h] of hosts) (h.host as unknown as { notify: WebHost["notify"] }).notify = (_level, text) => void told.push(`${id}: ${text}`);
    router.notify("info", "Updating to 0.6.0…");
    expect(told.sort()).toEqual(["app: Updating to 0.6.0…", "default: Updating to 0.6.0…"]);
  });
});
