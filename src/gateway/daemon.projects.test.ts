// src/gateway/daemon.projects.test.ts — projects and services in the running gateway: Telegram and the model are fakes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel, reply, textBlock } from "../../test/helpers/fake-model";
import { FakeTelegramServer } from "../../test/helpers/telegram-fake-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { main } from "../cli/main";
import { localBackend } from "../exec/local";
import type { ExecBackend } from "../exec/backend";
import { addProject } from "./projects";
import { TelegramApi } from "./telegram/api";
import type { ChatSession, GatewayService, GatewayServiceDeps } from "./types";

const CHAT = 4242;

let dir: string;
let home: string;
let server: FakeTelegramServer;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-projects-e2e");
  home = join(dir, "home");
  await mkdir(join(dir, "app", ".git"), { recursive: true });
  await mkdir(join(dir, "bad", ".tropos"), { recursive: true });
  await Bun.write(join(dir, "bad", ".tropos", "settings.json"), "{not json");
  server = new FakeTelegramServer();
});
afterEach(async () => {
  server.stop();
  await removeDir(dir);
});

function startGateway(steps: (() => ReturnType<typeof reply>)[], services: GatewayService[] = []) {
  const err: string[] = [];
  const workspaces: string[] = [];
  const model = new FakeModel(steps);
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const done = main(["gateway", "--no-web"], {
    model,
    out: () => {},
    err: (s) => err.push(s),
    env: { TROPOS_HOME: home, SHELL: "/bin/bash", TROPOS_TELEGRAM_BOT_TOKEN: server.token },
    cwd: dir,
    gatewayUntil: () => stopped,
    gatewayServices: services,
    gatewaySeams: {
      sweep: false,
      git: async () => {},
      sandboxCheck: async () => undefined,
      backend: (workspace) => {
        workspaces.push(workspace);
        return { ...localBackend, close: async () => {} } as ExecBackend;
      },
      telegramApi: new TelegramApi({ token: server.token, baseUrl: server.baseUrl, sleep: async () => {} }),
      telegramOptions: { minIntervalMs: 0, pollTimeoutSec: 1 },
      assets: new Map(),
    },
  });
  return { done, stop, err, model, workspaces };
}

/** Pairs the chat so its messages reach a session. */
async function pairChat() {
  server.pushMessage(CHAT, CHAT, "hello?");
  await server.waitFor(() => server.sent.length >= 1);
  const code = /approve telegram ([A-Z0-9]{8})/.exec(server.sent[0]!.text)![1]!;
  const out: string[] = [];
  expect(await main(["pairing", "approve", "telegram", code], { out: (s) => out.push(s), err: () => {}, env: { TROPOS_HOME: home }, cwd: dir })).toBe(0);
}

const lastText = () => server.textsTo(CHAT).at(-1) ?? "";
const sessionsFile = async () => JSON.parse(await readFile(join(home, "gateway", "sessions.json"), "utf8")) as Record<string, string>;

describe("projects in chats", () => {
  test("a chat starts in the default project, /project lists, /project <id> switches, and each project keeps its session", async () => {
    await mkdir(home, { recursive: true });
    await addProject(home, { path: join(dir, "app"), name: "App" }, { userHome: join(dir, "nobody") });
    const gw = startGateway([() => reply([textBlock("in default")]), () => reply([textBlock("in app")]), () => reply([textBlock("default again")])]);
    await server.waitFor(() => server.commands.length > 0);
    expect(server.commands.map((c) => c.command)).toContain("project");
    await pairChat();

    server.pushMessage(CHAT, CHAT, "where am I");
    await server.waitFor(() => server.textsTo(CHAT).includes("in default"));
    expect(Object.keys(await sessionsFile())).toEqual([`telegram:${CHAT}@default`]);
    const defaultSession = (await sessionsFile())[`telegram:${CHAT}@default`];

    server.pushMessage(CHAT, CHAT, "/project");
    const listing = await server.waitFor(() => server.sent.find((m) => m.text.startsWith("Project: Default workspace")));
    expect(listing.text).toContain("app  App");
    expect(listing.replyMarkup!.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(["p:default", "p:app"]);

    server.pushMessage(CHAT, CHAT, "/project app");
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.startsWith("Switched to App (app)")));
    server.pushMessage(CHAT, CHAT, "now");
    await server.waitFor(() => server.textsTo(CHAT).includes("in app"));
    expect(Object.keys(await sessionsFile()).sort()).toEqual([`telegram:${CHAT}@app`, `telegram:${CHAT}@default`]);
    expect(gw.workspaces).toEqual([join(home, "workspace"), join(dir, "app")]);

    // Switching back with the button resumes the first session; nothing was closed or lost.
    const button = listing.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
    server.pushCallback(CHAT, CHAT, listing.messageId, button);
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.startsWith("Switched to Default workspace")));
    server.pushMessage(CHAT, CHAT, "back");
    await server.waitFor(() => server.textsTo(CHAT).includes("default again"));
    expect((await sessionsFile())[`telegram:${CHAT}@default`]).toBe(defaultSession!);
    expect(JSON.parse(await readFile(join(home, "gateway", "chats.json"), "utf8"))).toEqual({ [`telegram:${CHAT}`]: "default" });

    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("a project with broken settings fails only its own chats, with a message, and the chat can leave it", async () => {
    await mkdir(home, { recursive: true });
    await addProject(home, { path: join(dir, "bad"), name: "Bad" }, { userHome: join(dir, "nobody") });
    const gw = startGateway([() => reply([textBlock("fine here")])]);
    await server.waitFor(() => server.commands.length > 0);
    await pairChat();

    server.pushMessage(CHAT, CHAT, "/project bad");
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.startsWith("Switched to Bad")));
    server.pushMessage(CHAT, CHAT, "hello");
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes('settings of project "Bad" are invalid')));
    expect(gw.model.requests).toHaveLength(0);

    // The way out works even though the current project can't start.
    server.pushMessage(CHAT, CHAT, "/project default");
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.startsWith("Switched to Default workspace")));
    server.pushMessage(CHAT, CHAT, "hello again");
    await server.waitFor(() => server.textsTo(CHAT).includes("fine here"));
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("/project with an unknown id says so and stays put", async () => {
    const gw = startGateway([]);
    await server.waitFor(() => server.commands.length > 0);
    await pairChat();
    server.pushMessage(CHAT, CHAT, "/project nope");
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes('no project "nope"')));
    gw.stop();
    await gw.done;
  });
});

describe("gateway services", () => {
  function fakeService(over: Partial<GatewayService> = {}) {
    const log: string[] = [];
    let deps: GatewayServiceDeps | undefined;
    const service: GatewayService = {
      name: "fake",
      async start(d) {
        log.push("start");
        deps = d;
      },
      async stop() {
        log.push("stop");
      },
      ...over,
    };
    return { service, log, deps: () => deps! };
  }

  test("is started after the channels with deps that can deliver to a chat and open sessions, and stopped on shutdown", async () => {
    const fake = fakeService();
    const gw = startGateway([() => reply([textBlock("scheduled answer")])], [fake.service]);
    await server.waitFor(() => fake.log.includes("start"));
    expect(server.commands.length).toBeGreaterThan(0); // the Telegram adapter had started
    const deps = fake.deps();
    expect(deps.home).toBe(home);
    expect((await deps.projects.list()).map((p) => p.id)).toEqual(["default"]);

    await deps.deliver(`telegram:${CHAT}`, "hello from a job");
    expect(server.textsTo(CHAT)).toContain("hello from a job");
    await expect(deps.deliver("email:me", "x")).rejects.toThrow(/No channel/);

    const session: ChatSession = await deps.openSession("default");
    expect(await session.prompt("run the job")).toBe("end_turn");
    expect(Object.keys(await sessionsFile())).toEqual(["project:default@default"]);
    await expect(deps.openSession("ghost")).rejects.toThrow(/no project "ghost"/);

    gw.stop();
    expect(await gw.done).toBe(0);
    expect(fake.log).toEqual(["start", "stop"]);
  });

  test("delivery splits at Telegram's 4096 characters", async () => {
    const fake = fakeService();
    const gw = startGateway([], [fake.service]);
    await server.waitFor(() => fake.log.includes("start"));
    await fake.deps().deliver(`telegram:${CHAT}`, `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
    expect(server.textsTo(CHAT).map((t) => t.length)).toEqual([3000, 3000]);
    gw.stop();
    await gw.done;
  });

  test("a service that fails to start is reported and the gateway carries on; it isn't stopped", async () => {
    const bad = fakeService({
      async start() {
        throw new Error("no schedule file");
      },
    });
    const good = fakeService();
    const gw = startGateway([], [bad.service, good.service]);
    await server.waitFor(() => good.log.includes("start"));
    expect(gw.err.join("")).toContain("service fake failed to start: no schedule file");
    gw.stop();
    expect(await gw.done).toBe(0);
    expect(bad.log).toEqual([]);
    expect(good.log).toEqual(["start", "stop"]);
  });
});
