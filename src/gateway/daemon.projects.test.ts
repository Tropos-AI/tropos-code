// src/gateway/daemon.projects.test.ts — projects and services in the running gateway: Telegram and the model are fakes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel, reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { FakeTelegramServer } from "../../test/helpers/telegram-fake-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { main } from "../cli/main";
import { localBackend } from "../exec/local";
import type { ExecBackend } from "../exec/backend";
import { gatewayConfigSchema, saveGatewayConfig } from "./config";
import { readGatewayState, type GatewayRun } from "./daemon";
import { addProject } from "./projects";
import { TelegramApi } from "./telegram/api";
import type { ChatSession, ChatSink, GatewayService, GatewayServiceDeps } from "./types";

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

type UntilInfo = Parameters<NonNullable<GatewayRun["until"]>>[0];

function startGateway(steps: Step[], services: GatewayService[] = [], opts: { botTokenInEnv?: boolean } = {}) {
  const err: string[] = [];
  const workspaces: string[] = [];
  const backendsClosed: string[] = [];
  const model = new FakeModel(steps);
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  let info: UntilInfo | undefined;
  const done = main(["gateway", "--no-web"], {
    model,
    out: () => {},
    err: (s) => err.push(s),
    env: { TROPOS_HOME: home, SHELL: "/bin/bash", ...(opts.botTokenInEnv === false ? {} : { TROPOS_TELEGRAM_BOT_TOKEN: server.token }) },
    cwd: dir,
    gatewayUntil: (i) => {
      info = i;
      return stopped;
    },
    gatewayServices: services,
    gatewaySeams: {
      sweep: false,
      git: async () => {},
      sandboxCheck: async () => undefined,
      backend: (workspace) => {
        workspaces.push(workspace);
        return { ...localBackend, close: async () => void backendsClosed.push(workspace) } as ExecBackend;
      },
      telegramApi: new TelegramApi({ token: server.token, baseUrl: server.baseUrl, sleep: async () => {} }),
      telegramOptions: { minIntervalMs: 0, pollTimeoutSec: 1 },
      assets: new Map(),
    },
  });
  /** The `until` info, once the gateway is running. */
  const running = () => server.waitFor(() => info);
  return { done, stop, err, model, workspaces, backendsClosed, running };
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

describe("learning in the owner's chat", () => {
  test("the owner's chat saves a memory without asking and gets '💡 Remembered: …' after the answer", async () => {
    const gw = startGateway([
      () => reply([toolUseBlock("m1", "Memory", { target: "user", action: "add", content: "prefers bun" })], "tool_use"),
      () => reply([textBlock("Noted.")]),
    ]);
    await server.waitFor(() => server.commands.length > 0);
    expect(server.commands.map((c) => c.command)).toContain("learned");
    await pairChat();

    server.pushMessage(CHAT, CHAT, "remember that I prefer bun");
    await server.waitFor(() => server.textsTo(CHAT).includes("💡 Remembered: prefers bun"));
    const texts = server.textsTo(CHAT);
    // No permission question, and the notice follows the answer.
    expect(server.sent.some((m) => m.replyMarkup)).toBe(false);
    expect(texts.indexOf("Noted.")).toBeGreaterThan(-1);
    expect(texts.indexOf("💡 Remembered: prefers bun")).toBeGreaterThan(texts.indexOf("Noted."));

    gw.stop();
    expect(await gw.done).toBe(0);
  });
});

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

describe("reload", () => {
  const MCP_SERVER = join(import.meta.dir, "../../test/helpers/mcp-test-server.ts");
  const mcpServer = () => ({ type: "stdio", command: process.execPath, args: [MCP_SERVER] });
  const toolNames = (i: number, model: FakeModel) => model.requests[i]!.tools.map((t) => t.name);

  test("a bot token saved after start works after reload, without a restart", async () => {
    const gw = startGateway([], [], { botTokenInEnv: false });
    const info = await gw.running();
    // No token yet: no channel was started.
    expect(server.commands).toEqual([]);
    expect((await readGatewayState(home))?.telegram).toBe(false);

    await saveGatewayConfig(home, gatewayConfigSchema.parse({ telegram: { botToken: server.token } }));
    await info.reload();
    server.pushMessage(CHAT, CHAT, "hello?");
    const pairingReply = await server.waitFor(() => server.sent.find((m) => m.chatId === CHAT && m.text.includes("approve telegram")));
    expect(pairingReply.text).toContain("This bot is private");
    expect((await readGatewayState(home))?.telegram).toBe(true);

    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("reload during a running turn lets it finish; the next message continues the same transcript", async () => {
    await mkdir(home, { recursive: true });
    await Bun.write(join(home, "settings.json"), JSON.stringify({ mcpServers: { t: mcpServer() } }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let deps: GatewayServiceDeps | undefined;
    const service: GatewayService = { name: "probe", start: async (d) => void (deps = d), stop: async () => {} };
    const gw = startGateway(
      [
        // The turn calls an MCP tool only after the reload has happened.
        async () => (await gate, reply([toolUseBlock("t1", "mcp__t__echo", { text: "still here" })], "tool_use")),
        () => reply([textBlock("first answer")]),
        () => reply([textBlock("second answer")]),
      ],
      [service],
    );
    const info = await gw.running();
    // A private chat whose sender isn't approved gets no session at all.
    await expect(deps!.openSession("telegram:777")).rejects.toThrow("no longer approved");
    await pairChat();
    const chatKey = `telegram:${CHAT}`;
    const chat = await deps!.openSession(chatKey);
    const allow: ChatSink = { event: () => {}, ask: (id) => chat.answer(id, { kind: "allow" }), askClosed: () => {}, state: () => {} };
    chat.attach(allow);
    const turn = chat.prompt("first question");
    await server.waitFor(() => gw.model.requests.length === 1);
    const sessionId = (await sessionsFile())[`${chatKey}@default`];

    // Meanwhile a second MCP server is saved in the dashboard, which reloads the gateway.
    await Bun.write(join(home, "settings.json"), JSON.stringify({ mcpServers: { t: mcpServer(), u: mcpServer() } }));
    await info.reload();
    expect(gw.backendsClosed).toEqual([]);

    release();
    expect(await turn).toBe("end_turn");
    // The tool ran after the reload on the old context's MCP server, which was still open.
    const toolResult = JSON.stringify(gw.model.requests[1]!.messages.at(-1));
    expect(toolResult).toContain("still here");
    expect(toolResult).not.toContain('"is_error":true');
    expect(toolNames(1, gw.model)).not.toContain("mcp__u__echo");

    // The next message, on the same handle: the old session is closed, and a fresh one on a fresh context resumes the
    // same transcript.
    expect(await chat.prompt("second question")).toBe("end_turn");
    expect(gw.backendsClosed).toEqual([join(home, "workspace")]);
    const resumed = JSON.stringify(gw.model.requests[2]!.messages);
    expect(resumed).toContain("first question");
    expect(resumed).toContain("first answer");
    expect(toolNames(2, gw.model)).toContain("mcp__u__echo");
    expect((await sessionsFile())[`${chatKey}@default`]).toBe(sessionId!);

    gw.stop();
    expect(await gw.done).toBe(0);
  });
  test("through Telegram: a turn running during a dashboard save is answered, and later messages run on fresh sessions", async () => {
    await mkdir(home, { recursive: true });
    await Bun.write(join(home, "settings.json"), JSON.stringify({ mcpServers: { t: mcpServer() } }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const withU = (req: { tools: { name: string }[] }) => (req.tools.some((t) => t.name === "mcp__u__echo") ? "with u" : "without u");
    const gw = startGateway([
      async () => (await gate, reply([toolUseBlock("t1", "mcp__t__echo", { text: "still here" })], "tool_use")),
      () => reply([textBlock("first answer")]),
      (req) => reply([textBlock(`second answer, ${withU(req)}`)]),
      () => reply([textBlock("third answer")]),
    ]);
    const info = await gw.running();
    await server.waitFor(() => server.commands.length > 0);
    await pairChat(); // update 100

    server.pushMessage(CHAT, CHAT, "first question"); // update 101
    await server.waitFor(() => gw.model.requests.length === 1);
    // The dashboard saves a second MCP server while the turn runs.
    await Bun.write(join(home, "settings.json"), JSON.stringify({ mcpServers: { t: mcpServer(), u: mcpServer() } }));
    await info.reload();
    // A message sent mid-turn waits its turn in the chat (update 102 handled once the adapter polls past it).
    server.pushMessage(CHAT, CHAT, "second question");
    await server.waitFor(() => Math.max(...server.getUpdatesOffsets) >= 103);
    expect(gw.backendsClosed).toEqual([]);

    release();
    // The turn goes on in the same chat: its approval prompt arrives and is answered, and so is the question.
    const ask = await server.waitFor(() => server.sent.find((m) => m.replyMarkup));
    server.pushCallback(CHAT, CHAT, ask.messageId, ask.replyMarkup!.inline_keyboard[0]![0]!.callback_data);
    await server.waitFor(() => server.textsTo(CHAT).includes("first answer"));
    expect(JSON.stringify(gw.model.requests[1]!.messages.at(-1))).toContain("still here");

    // The waiting message runs after the turn, on a fresh session and context that resume the transcript.
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.startsWith("second answer")));
    expect(server.textsTo(CHAT)).toContain("second answer, with u");
    expect(JSON.stringify(gw.model.requests[2]!.messages)).toContain("first answer");
    expect(gw.backendsClosed).toHaveLength(1);

    // Another save with nothing running closes the session at once; the chat's next message still gets an answer.
    await info.reload();
    expect(gw.backendsClosed).toHaveLength(2);
    server.pushMessage(CHAT, CHAT, "third question");
    await server.waitFor(() => server.textsTo(CHAT).includes("third answer"));
    expect(JSON.stringify(gw.model.requests[3]!.messages)).toContain("second answer, with u");
    expect(gw.workspaces).toHaveLength(3);
    expect(server.textsTo(CHAT).join("\n")).not.toContain("gateway stopped");

    gw.stop();
    expect(await gw.done).toBe(0);
  });
});

describe("revocation", () => {
  test("a message queued when its sender is revoked never runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gw = startGateway([async () => (await gate, reply([textBlock("first answer")])), () => reply([textBlock("must never run")])]);
    await server.waitFor(() => server.commands.length > 0);
    await pairChat(); // update 100
    server.pushMessage(CHAT, CHAT, "first question"); // update 101
    await server.waitFor(() => gw.model.requests.length === 1);
    server.pushMessage(CHAT, CHAT, "queued question"); // update 102, queued behind the running turn
    await server.waitFor(() => Math.max(...server.getUpdatesOffsets) >= 103);

    expect(await main(["pairing", "revoke", "telegram", String(CHAT)], { out: () => {}, err: () => {}, env: { TROPOS_HOME: home }, cwd: dir })).toBe(0);
    // The reaper (every 5 s) closes the running session.
    await server.waitFor(() => gw.err.join("").includes("revoked sender: closed 1 session(s)"), 8_000);
    const sent = server.sent.length;
    release();
    await Bun.sleep(300);
    // The queued text didn't get a fresh session and a turn of its own, and the revoked chat isn't answered.
    expect(gw.model.requests).toHaveLength(1);
    expect(server.textsTo(CHAT).join("\n")).not.toContain("must never run");
    expect(server.sent.slice(sent).map((m) => m.text).join("\n")).not.toContain("went wrong");

    gw.stop();
    expect(await gw.done).toBe(0);
  }, 15_000);
});
