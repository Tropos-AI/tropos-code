// src/gateway/daemon.projects.test.ts — projects and services in the running gateway: Telegram and the model are fakes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel, reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { FakeTelegramServer } from "../../test/helpers/telegram-fake-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { makeToolContext } from "../../test/helpers/tool-context";
import { createSessionSearchTool } from "../memory/session-search";
import { projectDir } from "../session/store";
import { main } from "../cli/main";
import { localBackend } from "../exec/local";
import type { ExecBackend } from "../exec/backend";
import { CronStore } from "./cron/store";
import { FilePairing } from "./pairing";
import { loginCodesFor } from "../web/login-codes";
import { gatewayConfigSchema, saveGatewayConfig } from "./config";
import { readGatewayState, type GatewayRun } from "./daemon";
import { git, makeRepo } from "../snapshots/test-repo";
import { addProject, setProjectShared } from "./projects";
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
/** Gateways a test started. One a failed test left running is stopped, so it can't keep polling into the next test. */
const gateways: Array<{ stop(): void; done: Promise<number> }> = [];
afterEach(async () => {
  for (const gw of gateways.splice(0)) {
    gw.stop();
    await gw.done.catch(() => {});
  }
  server.stop();
  await removeDir(dir);
});

type UntilInfo = Parameters<NonNullable<GatewayRun["until"]>>[0];

function startGateway(steps: Step[], services: GatewayService[] = [], opts: { botTokenInEnv?: boolean; web?: boolean; seams?: Partial<NonNullable<GatewayRun["seams"]>> } = {}) {
  const err: string[] = [];
  const workspaces: string[] = [];
  const backendsClosed: string[] = [];
  const model = new FakeModel(steps);
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  let info: UntilInfo | undefined;
  const done = main(["gateway", ...(opts.web ? [] : ["--no-web"])], {
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
      webPort: 0,
      git: async () => {},
      sandboxCheck: async () => undefined,
      backend: (workspace) => {
        workspaces.push(workspace);
        // Commands run on the host; the backend only records that it was closed.
        return {
          kind: "local",
          spawn: (o) => localBackend.spawn(o),
          cwdMarker: (id) => localBackend.cwdMarker(id),
          signal: (child, sig) => localBackend.signal(child, sig),
          alive: (child) => localBackend.alive(child),
          close: async () => void backendsClosed.push(workspace),
        } satisfies ExecBackend;
      },
      telegramApi: new TelegramApi({ token: server.token, baseUrl: server.baseUrl, sleep: async () => {} }),
      telegramOptions: { minIntervalMs: 0, pollTimeoutSec: 1 },
      assets: new Map(),
      ...opts.seams,
    },
  });
  gateways.push({ stop, done });
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
/**
 * Sends a switch (a /project message or a button press) until it lands. The answer is shown before its turn has wrapped
 * up (the worktree check after it), and a switch meanwhile is refused with "A turn is still running".
 */
async function switchProject(send: () => void, name: string) {
  for (;;) {
    const before = server.sent.length;
    send();
    const note = await server.waitFor(() => server.sent.slice(before).find((m) => m.chatId === CHAT && (m.text.startsWith(`Switched to ${name}`) || m.text.startsWith("A turn is still running"))));
    if (note.text.startsWith("Switched")) return;
  }
}
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

describe("/login in the owner's chat", () => {
  test("hands out a code that redeems once through the shared login codes, with the dashboard address", async () => {
    const gw = startGateway([], [], { web: true });
    await server.waitFor(() => server.commands.length > 0);
    const info = await gw.running();
    await pairChat();
    server.pushMessage(CHAT, CHAT, "/login");
    await server.waitFor(() => lastText().startsWith("Login code: "));
    const text = lastText();
    const code = /Login code: (\d{3}) (\d{3}) \(works once, for 10 minutes\)/.exec(text);
    expect(code).not.toBeNull();
    expect(text).toContain(`On the Mac: ${info.webUrl}`);
    const logins = loginCodesFor(home);
    expect(await logins.redeem(`${code![1]}${code![2]}`)).toBe(true);
    expect(await logins.redeem(`${code![1]}${code![2]}`)).toBe(false);
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("with phone access on, the message also carries the tailnet address", async () => {
    await saveGatewayConfig(home, gatewayConfigSchema.parse({ remoteAccess: { tailscale: true, httpsPort: 8443, hostname: "mac.tail1234.ts.net" } }));
    const gw = startGateway([], [], { web: true });
    await server.waitFor(() => server.commands.length > 0);
    await gw.running();
    await pairChat();
    server.pushMessage(CHAT, CHAT, "/login");
    await server.waitFor(() => lastText().startsWith("Login code: "));
    expect(lastText()).toContain("On your phone: https://mac.tail1234.ts.net:8443/");
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("the tailnet Host is accepted only while phone access is on, and a reload applies a change at once", async () => {
    const gw = startGateway([], [], { web: true });
    await server.waitFor(() => server.commands.length > 0);
    const info = await gw.running();
    const askAs = async (host: string) => (await fetch(info.webUrl!, { headers: { Host: host } })).status;
    expect(await askAs("mac.tail1234.ts.net")).toBe(421);
    await saveGatewayConfig(home, gatewayConfigSchema.parse({ remoteAccess: { tailscale: true, httpsPort: 443, hostname: "mac.tail1234.ts.net" } }));
    await info.reload();
    // Past the Host check (the test gateway has no built assets to serve, so 503 is the page itself).
    expect(await askAs("mac.tail1234.ts.net")).not.toBe(421);
    await saveGatewayConfig(home, gatewayConfigSchema.parse({}));
    await info.reload();
    expect(await askAs("mac.tail1234.ts.net")).toBe(421);
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("without a dashboard it says so instead of handing out a useless code", async () => {
    const gw = startGateway([]);
    await server.waitFor(() => server.commands.length > 0);
    await pairChat();
    server.pushMessage(CHAT, CHAT, "/login");
    await server.waitFor(() => lastText().includes("dashboard isn't running"));
    gw.stop();
    expect(await gw.done).toBe(0);
  });
});

describe("chat roles reach the session", () => {
  const GUEST = 5151;
  async function pair(chat: number) {
    const before = server.sent.length;
    server.pushMessage(chat, chat, "hello?");
    const sent = await server.waitFor(() => server.sent.slice(before).find((m) => m.chatId === chat && m.text.includes("approve telegram")));
    const code = /approve telegram ([A-Z0-9]{8})/.exec(sent.text)![1]!;
    expect(await main(["pairing", "approve", "telegram", code], { out: () => {}, err: () => {}, env: { TROPOS_HOME: home }, cwd: dir })).toBe(0);
  }

  test("the owner's chat has TroposSetup and SwitchProject, a guest's only SwitchProject; \"work on app\" moves the chat", async () => {
    await mkdir(home, { recursive: true });
    await addProject(home, { path: join(dir, "app") });
    const gw = startGateway([
      () => reply([toolUseBlock("s1", "SwitchProject", { project: "app" })], "tool_use"),
      () => reply([textBlock("switched")]),
      () => reply([textBlock("in app")]),
      () => reply([textBlock("guest here")]),
    ]);
    await server.waitFor(() => server.commands.length > 0);
    await pair(CHAT);
    await pair(GUEST);
    server.pushMessage(CHAT, CHAT, "work on app");
    await server.waitFor(() => server.textsTo(CHAT).includes("switched"));
    const names = (i: number) => gw.model.requests[i]!.tools.map((t) => t.name);
    expect(names(0)).toEqual(expect.arrayContaining(["TroposSetup", "SwitchProject", "Cron"]));
    server.pushMessage(CHAT, CHAT, "and now?");
    await server.waitFor(() => server.textsTo(CHAT).includes("in app"));
    expect(Object.keys(await sessionsFile())).toContain(`telegram:${CHAT}@app`);
    server.pushMessage(GUEST, GUEST, "hey");
    await server.waitFor(() => server.textsTo(GUEST).includes("guest here"));
    expect(names(3)).toContain("SwitchProject");
    expect(names(3)).not.toContain("TroposSetup");
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("a guest's chat works in the guest workspace, never in the chief's", async () => {
    const gw = startGateway([() => reply([textBlock("owner here")]), () => reply([textBlock("guest here")])]);
    await server.waitFor(() => server.commands.length > 0);
    await pair(CHAT);
    await pair(GUEST);
    server.pushMessage(CHAT, CHAT, "hi");
    await server.waitFor(() => server.textsTo(CHAT).includes("owner here"));
    server.pushMessage(GUEST, GUEST, "hey");
    await server.waitFor(() => server.textsTo(GUEST).includes("guest here"));
    expect(Object.keys(await sessionsFile()).sort()).toEqual([`telegram:${CHAT}@default`, `telegram:${GUEST}@guest`].sort());
    expect(gw.workspaces.map((w) => realpathSync(w))).toEqual([realpathSync(join(home, "workspace")), realpathSync(join(home, "guest-workspace"))]);
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("the owner's chat hears a skipped setup step once and has Suggestion; a guest's chat neither", async () => {
    await mkdir(home, { recursive: true });
    await Bun.write(join(home, "onboarding.json"), JSON.stringify({ skipped: ["phone"] }));
    const gw = startGateway([() => reply([textBlock("owner here")]), () => reply([textBlock("guest here")])]);
    await server.waitFor(() => server.commands.length > 0);
    await pair(CHAT);
    await pair(GUEST);
    server.pushMessage(CHAT, CHAT, "hi");
    await server.waitFor(() => server.textsTo(CHAT).includes("owner here"));
    server.pushMessage(GUEST, GUEST, "hey");
    await server.waitFor(() => server.textsTo(GUEST).includes("guest here"));
    const first = (i: number) => JSON.stringify(gw.model.requests[i]!.messages[0]);
    expect(first(0)).toContain("[setup:phone]");
    expect(gw.model.requests[0]!.tools.map((t) => t.name)).toContain("Suggestion");
    expect(first(1)).not.toContain("<suggestions>");
    expect(gw.model.requests[1]!.tools.map((t) => t.name)).not.toContain("Suggestion");
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("the owner's chat runs the background review; a guest's chat never does", async () => {
    await mkdir(home, { recursive: true });
    await Bun.write(join(home, "settings.json"), JSON.stringify({ learning: { interval: 2 } }));
    const answer = (t: string): Step => () => reply([textBlock(t)]);
    const gw = startGateway([answer("owner a"), answer("owner b"), answer("NOTHING"), answer("guest c"), answer("guest d")]);
    await server.waitFor(() => server.commands.length > 0);
    await pair(CHAT); // the first approval is the owner
    await pair(GUEST);
    server.pushMessage(CHAT, CHAT, "one");
    await server.waitFor(() => server.textsTo(CHAT).includes("owner a"));
    server.pushMessage(CHAT, CHAT, "two");
    // The owner's second turn starts a review: a third model request.
    await server.waitFor(() => gw.model.requests.length === 3);
    server.pushMessage(GUEST, GUEST, "three");
    await server.waitFor(() => server.textsTo(GUEST).includes("guest c"));
    server.pushMessage(GUEST, GUEST, "four");
    await server.waitFor(() => server.textsTo(GUEST).includes("guest d"));
    await Bun.sleep(200);
    expect(gw.model.requests).toHaveLength(5);
    // Each transcript records the role it ran as (SessionSearch leaves the guest's out).
    const ids = await sessionsFile();
    const roleOf = async (chat: number) => {
      // The owner's chat is in the default workspace, the guest's in the guest workspace.
      const key = chat === GUEST ? `telegram:${chat}@guest` : `telegram:${chat}@default`;
      for (const d of await readdir(join(home, "projects"))) {
        const path = join(home, "projects", d, `${ids[key]}.jsonl`);
        if (await Bun.file(path).exists()) return JSON.parse((await readFile(path, "utf8")).split("\n")[0]!).role;
      }
      return undefined;
    };
    expect(await roleOf(CHAT)).toBe("owner");
    expect(await roleOf(GUEST)).toBe("guest");
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("a guest chat resuming an older transcript without a role marks it guest, and owner search leaves it out", async () => {
    const gw = startGateway([() => reply([textBlock("hello again")])]);
    await server.waitFor(() => server.commands.length > 0);
    await pair(CHAT);
    await pair(GUEST);
    await mkdir(join(home, "guest-workspace"), { recursive: true });
    const workspace = realpathSync(join(home, "guest-workspace"));
    const id = "00000000-0000-4000-8000-000000000001";
    const transcript = join(projectDir(home, workspace), `${id}.jsonl`);
    await mkdir(projectDir(home, workspace), { recursive: true });
    await Bun.write(
      transcript,
      `${JSON.stringify({ type: "meta", sessionId: id, cwd: workspace })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "the zebra password is hunter2" }, ts: "2026-10-01T00:00:00Z" })}\n`,
    );
    await Bun.write(join(home, "gateway", "sessions.json"), JSON.stringify({ [`telegram:${GUEST}@guest`]: id }));
    server.pushMessage(GUEST, GUEST, "again");
    await server.waitFor(() => server.textsTo(GUEST).includes("hello again"));
    const metas = (await readFile(transcript, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === "meta");
    expect(metas.map((m) => m.role).filter(Boolean)).toEqual(["guest"]);
    const search = createSessionSearchTool({ home, cwd: workspace, index: null });
    expect(String((await search.run({ query: "zebra" }, makeToolContext())).content)).not.toContain("hunter2");
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("the reaper closes a revoked owner's chat without the final review", async () => {
    const answer = (t: string): Step => () => reply([textBlock(t)]);
    const gw = startGateway([answer("a"), answer("b"), answer("NOTHING")], [], { seams: { reapEveryMs: 100 } });
    await server.waitFor(() => server.commands.length > 0);
    await pairChat();
    server.pushMessage(CHAT, CHAT, "one");
    await server.waitFor(() => server.textsTo(CHAT).includes("a"));
    server.pushMessage(CHAT, CHAT, "two");
    await server.waitFor(() => server.textsTo(CHAT).includes("b"));
    // Two turns: a final review would be due if the session closed normally.
    expect(await main(["pairing", "revoke", "telegram", String(CHAT)], { out: () => {}, err: () => {}, env: { TROPOS_HOME: home }, cwd: dir })).toBe(0);
    await server.waitFor(() => gw.err.join("").includes("revoked sender: closed 1 session(s)"));
    // The close awaited the session's shutdown, where a final review would have run.
    expect(gw.model.requests).toHaveLength(2);
    gw.stop();
    expect(await gw.done).toBe(0);
  });
});

describe("scheduling from chats", () => {
  test("an owner's Cron tool lists every chat's jobs; a guest's lists only their own", async () => {
    const job = new CronStore(home).add({ name: "elsewhere", schedule: { kind: "every", ms: 120_000 }, prompt: "p", project: "default", deliver: "telegram:555", createdBy: "agent" });
    const listCron = (id: string) => () => reply([toolUseBlock(id, "Cron", { action: "list" })], "tool_use");
    let deps: GatewayServiceDeps | undefined;
    const service: GatewayService = { name: "fake", start: async (d) => void (deps = d), stop: async () => {} };
    const gw = startGateway([listCron("c1"), () => reply([textBlock("done")]), listCron("c2"), () => reply([textBlock("done")])], [service]);
    await gw.running();
    await pairChat(); // CHAT is the first approved sender: the owner
    const pairing = new FilePairing({ path: join(home, "gateway", "pairing.json") });
    const challenge = await pairing.challenge("telegram", "777");
    if (challenge.kind !== "code") throw new Error("expected a code");
    expect(await pairing.approve("telegram", challenge.code)).toMatchObject({ ok: true });
    expect(await pairing.isOwner("telegram", "777")).toBe(false);

    const open = async (key: string) => {
      const chat = await deps!.openSession(key);
      chat.attach({ event: () => {}, ask: (id) => chat.answer(id, { kind: "allow" }), askClosed: () => {}, state: () => {} });
      return chat;
    };
    expect(await (await open(`telegram:${CHAT}`)).prompt("what is scheduled?")).toBe("end_turn");
    expect(JSON.stringify(gw.model.requests[1]!.messages.at(-1))).toContain(job.id);
    expect(await (await open("telegram:777")).prompt("what is scheduled?")).toBe("end_turn");
    const guestResult = JSON.stringify(gw.model.requests[3]!.messages.at(-1));
    expect(guestResult).toContain("No scheduled jobs.");
    expect(guestResult).not.toContain(job.id);

    gw.stop();
    expect(await gw.done).toBe(0);
  });
});

describe.skipIf(Bun.which("git") === null)("a guest's scheduled job", () => {
  test("runs in a worktree of a shared repo, else in the guest workspace; never in the owner's checkout", async () => {
    const repo = await makeRepo();
    try {
      await mkdir(home, { recursive: true });
      await addProject(home, { path: repo, name: "App" }, { userHome: join(dir, "nobody") });
      await addProject(home, { path: join(dir, "app"), name: "Private" }, { userHome: join(dir, "nobody") });
      await setProjectShared(home, "app", true);
      let deps: GatewayServiceDeps | undefined;
      const service: GatewayService = { name: "fake", start: async (d) => void (deps = d), stop: async () => {} };
      const gw = startGateway([() => reply([textBlock("in the repo")]), () => reply([textBlock("in the guest workspace")])], [service]);
      await gw.running();
      expect(await (await deps!.openSession("app", { untrusted: true })).prompt("guest job")).toBe("end_turn");
      expect(gw.workspaces[0]!.startsWith(join(home, "worktrees", "app") + "/")).toBe(true);
      expect(await (await deps!.openSession("default", { untrusted: true })).prompt("guest job")).toBe("end_turn");
      expect(realpathSync(gw.workspaces[1]!)).toBe(realpathSync(join(home, "guest-workspace")));
      // A project the owner didn't share is not there for a guest's job.
      await expect(deps!.openSession("private", { untrusted: true })).rejects.toThrow(/no project "private"/);
      expect(git(repo, "status", "--porcelain")).toBe("");
      gw.stop();
      expect(await gw.done).toBe(0);
    } finally {
      await removeDir(repo);
    }
  });
});

describe.skipIf(Bun.which("git") === null)("worktrees in chats", () => {
  test("a chat in a registered repo works in a worktree, gets the end-of-task buttons, and Keep branch commits it", async () => {
    const repo = await makeRepo();
    try {
      await mkdir(home, { recursive: true });
      await addProject(home, { path: repo, name: "App" }, { userHome: join(dir, "nobody") });
      // The second turn "changes" a file in the worktree the chat works in (the first backend's workspace).
      const gw: ReturnType<typeof startGateway> = startGateway([
        () => reply([textBlock("one")]),
        () => {
          writeFileSync(join(gw.workspaces[0]!, "new.txt"), "x\n");
          return reply([textBlock("two")]);
        },
      ]);
      await server.waitFor(() => server.commands.length > 0);
      await pairChat();
      server.pushMessage(CHAT, CHAT, "/project app");
      await server.waitFor(() => server.textsTo(CHAT).some((t) => t.startsWith("Switched to App (app)")));
      server.pushMessage(CHAT, CHAT, "start");
      await server.waitFor(() => server.textsTo(CHAT).includes("one"));
      const worktree = gw.workspaces[0]!;
      expect(worktree.startsWith(join(home, "worktrees", "app") + "/")).toBe(true);
      // No changes yet, so no buttons; the owner's checkout is untouched.
      expect(server.sent.some((m) => m.replyMarkup)).toBe(false);

      server.pushMessage(CHAT, CHAT, "change something");
      const buttons = await server.waitFor(() => server.sent.find((m) => m.text.startsWith("Changes on tropos/")));
      expect(buttons.text).toEndWith("1 file changed.");
      expect(git(repo, "status", "--porcelain")).toBe("");

      server.pushCallback(CHAT, CHAT, buttons.messageId, "wt:keep");
      await server.waitFor(() => buttons.edits.some((e) => e.text.includes("Kept the work")));
      const branch = buttons.text.match(/tropos\/[\w-]+/)![0];
      expect(git(repo, "show", `${branch}:new.txt`)).toBe("x\n");
      expect(gw.backendsClosed).toContain(worktree);

      gw.stop();
      expect(await gw.done).toBe(0);
    } finally {
      await removeDir(repo);
    }
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

    await switchProject(() => server.pushMessage(CHAT, CHAT, "/project app"), "App (app)");
    server.pushMessage(CHAT, CHAT, "now");
    await server.waitFor(() => server.textsTo(CHAT).includes("in app"));
    expect(Object.keys(await sessionsFile()).sort()).toEqual([`telegram:${CHAT}@app`, `telegram:${CHAT}@default`]);
    expect(gw.workspaces).toEqual([join(home, "workspace"), join(dir, "app")]);

    // Switching back with the button resumes the first session; nothing was closed or lost.
    const button = listing.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
    await switchProject(() => server.pushCallback(CHAT, CHAT, listing.messageId, button), "Default workspace");
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
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes('because its settings have a problem')));
    const reply1 = server.textsTo(CHAT).find((t) => t.includes("because its settings have a problem"))!;
    expect(reply1).toBe('I can\'t start a session in "Bad" because its settings have a problem. The owner can see what\'s wrong in the dashboard (Status → Logs) or with tcode logs gateway.');
    expect(reply1).not.toContain("{not json");
    expect(gw.err.join("")).toMatch(/tcode: bad: project settings \S+\/bad\/\.tropos\/settings\.json: Invalid settings file/);
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

  test("an untrusted scheduled session is separate and recorded as a guest's; a plain one as scheduled", async () => {
    const fake = fakeService();
    const gw = startGateway([() => reply([textBlock("guest job output")]), () => reply([textBlock("owner job output")])], [fake.service]);
    await server.waitFor(() => fake.log.includes("start"));
    const untrusted = await fake.deps().openSession("default", { untrusted: true });
    expect(await untrusted.prompt("run the guest's job")).toBe("end_turn");
    const plain = await fake.deps().openSession("default");
    expect(await plain.prompt("run the owner's job")).toBe("end_turn");
    const ids = await sessionsFile();
    // A guest's job in the default project runs in the guest workspace.
    expect(Object.keys(ids).sort()).toEqual(["project:default@default", "project:guest:guest@guest"]);
    const roleOf = async (key: string) => {
      for (const d of await readdir(join(home, "projects"))) {
        const file = join(home, "projects", d, `${ids[key]}.jsonl`);
        if (await Bun.file(file).exists()) return JSON.parse((await readFile(file, "utf8")).split("\n")[0]!).role;
      }
      return undefined;
    };
    expect(await roleOf("project:guest:guest@guest")).toBe("guest");
    expect(await roleOf("project:default@default")).toBe("scheduled");
    expect(await fake.deps().ownerChat!()).toBeUndefined();
    await pairChat();
    expect(await fake.deps().ownerChat!()).toBe(`telegram:${CHAT}`);
    gw.stop();
    expect(await gw.done).toBe(0);
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
  test("a message queued when its sender is revoked never runs, even once they are approved again before it would have", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gw = startGateway([async () => (await gate, reply([textBlock("first answer")])), () => reply([textBlock("welcome back")])], [], { seams: { reapEveryMs: 100 } });
    await server.waitFor(() => server.commands.length > 0);
    await pairChat(); // update 100
    server.pushMessage(CHAT, CHAT, "first question"); // update 101
    await server.waitFor(() => gw.model.requests.length === 1);
    server.pushMessage(CHAT, CHAT, "queued question"); // update 102, queued behind the running turn
    await server.waitFor(() => Math.max(...server.getUpdatesOffsets) >= 103);

    expect(await main(["pairing", "revoke", "telegram", String(CHAT)], { out: () => {}, err: () => {}, env: { TROPOS_HOME: home }, cwd: dir })).toBe(0);
    await server.waitFor(() => gw.err.join("").includes("revoked sender: closed 1 session(s)"));
    const sent = server.sent.length;
    // Approved again while the revoked turn still runs, so the queued text would run next if it had been kept.
    server.pushMessage(CHAT, CHAT, "may I come back?");
    const challenge = await server.waitFor(() => server.sent.slice(sent).find((m) => m.chatId === CHAT && m.text.includes("approve telegram")));
    const code = /approve telegram ([A-Z0-9]{8})/.exec(challenge.text)![1]!;
    expect(await main(["pairing", "approve", "telegram", code], { out: () => {}, err: () => {}, env: { TROPOS_HOME: home }, cwd: dir })).toBe(0);
    release();
    server.pushMessage(CHAT, CHAT, "back again");
    await server.waitFor(() => gw.model.requests.length === 2);
    const second = JSON.stringify(gw.model.requests[1]!.messages);
    expect(second).toContain("back again");
    expect(second).not.toContain("queued question");
    await server.waitFor(() => server.textsTo(CHAT).includes("welcome back"));
    // The revoked chat wasn't answered in between, and nothing went wrong.
    expect(server.textsTo(CHAT).join("\n")).not.toContain("first answer");
    expect(server.sent.slice(sent).map((m) => m.text).join("\n")).not.toMatch(/went wrong|doesn't exist/);

    gw.stop();
    expect(await gw.done).toBe(0);
  });
});

describe("autonomy in chats and scheduled runs", () => {
  const GUEST = 5151;
  const bash = (id: string, command: string): Step => () => reply([toolUseBlock(id, "Bash", { command })], "tool_use");
  const say = (text: string): Step => () => reply([textBlock(text)]);
  const subagent = (id: string): Step => () => reply([toolUseBlock(id, "Agent", { description: "look", prompt: "list the files" })], "tool_use");
  /** The tool result the model saw in request `i`. */
  const resultIn = (model: FakeModel, i: number) => JSON.stringify(model.requests[i]!.messages.at(-1));
  const keyboards = (chat: number) => server.sent.filter((m) => m.chatId === chat && m.replyMarkup);
  const chatSettings = async () => (JSON.parse(await readFile(join(home, "gateway.json"), "utf8")) as { chat: unknown }).chat;
  async function pair(chat: number) {
    const before = server.sent.length;
    server.pushMessage(chat, chat, "hello?");
    const sent = await server.waitFor(() => server.sent.slice(before).find((m) => m.chatId === chat && m.text.includes("approve telegram")));
    const code = /approve telegram ([A-Z0-9]{8})/.exec(sent.text)![1]!;
    expect(await main(["pairing", "approve", "telegram", code], { out: () => {}, err: () => {}, env: { TROPOS_HOME: home }, cwd: dir })).toBe(0);
  }
  /** Presses Approve on the `n`th keyboard sent to `chat` (counting from 1) once it arrives, and returns its text. */
  async function approve(chat: number, n: number): Promise<string> {
    const ask = await server.waitFor(() => keyboards(chat)[n - 1]);
    server.pushCallback(chat, chat, ask.messageId, ask.replyMarkup!.inline_keyboard[0]![0]!.callback_data);
    return ask.text;
  }
  const writeGatewayJson = async (json: unknown) => {
    await mkdir(home, { recursive: true });
    await Bun.write(join(home, "gateway.json"), JSON.stringify(json));
  };

  test("a fresh install chats at balanced: a read-only command runs without asking, a write asks", async () => {
    const gw = startGateway([bash("b1", "ls"), bash("b2", "touch x"), say("done")]);
    await server.waitFor(() => server.commands.length > 0);
    // Written at start, before anyone is approved: a later approval can't turn this into an existing install.
    expect(await chatSettings()).toEqual({ autonomy: "balanced", backend: "host" });
    await pairChat();
    server.pushMessage(CHAT, CHAT, "list, then make a file");
    expect(await approve(CHAT, 1)).toContain("touch x");
    await server.waitFor(() => server.textsTo(CHAT).includes("done"));
    expect(keyboards(CHAT)).toHaveLength(1);
    expect(resultIn(gw.model, 1)).toContain("README.md"); // ls ran in the project
    expect(await chatSettings()).toEqual({ autonomy: "balanced", backend: "host" });
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("/autonomy ask from the owner applies to the open session at once", async () => {
    await writeGatewayJson({ chat: { autonomy: "balanced", backend: "host" } });
    const gw = startGateway([bash("b1", "ls"), say("listed"), bash("b2", "ls"), say("again")]);
    await server.waitFor(() => server.commands.length > 0);
    await pairChat();
    server.pushMessage(CHAT, CHAT, "list the files");
    await server.waitFor(() => server.textsTo(CHAT).includes("listed"));
    expect(keyboards(CHAT)).toHaveLength(0); // balanced: a read-only command runs unasked
    server.pushMessage(CHAT, CHAT, "/autonomy ask");
    await server.waitFor(() => server.textsTo(CHAT).includes("Autonomy in Default workspace is now ask."));
    expect(await chatSettings()).toEqual({ autonomy: "ask", backend: "host" });
    server.pushMessage(CHAT, CHAT, "list them again");
    expect(await approve(CHAT, 1)).toContain("ls"); // same open session, now asking
    await server.waitFor(() => server.textsTo(CHAT).includes("again"));
    // Raising is refused and leaves the file alone.
    server.pushMessage(CHAT, CHAT, "/autonomy autonomous");
    await server.waitFor(() => server.textsTo(CHAT).includes("A chat can only lower the autonomy level. Raise it on the computer: tcode config or the dashboard."));
    expect(await chatSettings()).toEqual({ autonomy: "ask", backend: "host" });
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("an existing install (gateway.json without chat, an approved sender in pairing.json) keeps asking for everything", async () => {
    await writeGatewayJson({ projects: [] });
    const pairing = new FilePairing({ path: join(home, "gateway", "pairing.json") });
    const challenge = await pairing.challenge("telegram", String(CHAT));
    if (challenge.kind !== "code") throw new Error("expected a code");
    expect(await pairing.approve("telegram", challenge.code)).toMatchObject({ ok: true });
    const gw = startGateway([bash("b1", "ls"), say("done")]);
    await server.waitFor(() => server.commands.length > 0);
    expect(await chatSettings()).toEqual({ autonomy: "ask", backend: "docker" });
    server.pushMessage(CHAT, CHAT, "list the files");
    expect(await approve(CHAT, 1)).toContain("ls");
    await server.waitFor(() => server.textsTo(CHAT).includes("done"));
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("without confinement or consent, the owner's chat opens on the host but stays at ask, whatever the level", async () => {
    await writeGatewayJson({ chat: { autonomy: "autonomous", backend: "host" } });
    // No backend seam: the gateway picks the real one, and with no confinement the owner's chat gets the bare host.
    const gw = startGateway([bash("b1", "ls"), say("done")], [], { seams: { backend: undefined, confinement: async () => null } });
    await server.waitFor(() => server.commands.length > 0);
    await pairChat();
    server.pushMessage(CHAT, CHAT, "list the files");
    expect(await approve(CHAT, 1)).toContain("ls");
    await server.waitFor(() => server.textsTo(CHAT).includes("done"));
    expect(resultIn(gw.model, 1)).toContain("README.md"); // approved, it ran on the host in the project
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("without confinement, a scheduled run (nobody to approve) gets no session, even with the owner's consent", async () => {
    await writeGatewayJson({ chat: { autonomy: "autonomous", backend: "host", allowUnconfined: true } });
    let deps: GatewayServiceDeps | undefined;
    const service: GatewayService = { name: "probe", start: async (d) => void (deps = d), stop: async () => {} };
    const gw = startGateway([], [service], { seams: { backend: undefined, confinement: async () => null } });
    await gw.running();
    const run = async () => {
      const session = await deps!.openSession("default");
      session.attach({ event: () => {}, ask: (id) => session.answer(id, { kind: "deny" }), askClosed: () => {}, state: () => {} });
      return session.prompt("run the job");
    };
    await expect(run()).rejects.toThrow("can't be confined on this machine");
    expect(gw.model.requests).toHaveLength(0);
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("without confinement, the owner's recorded consent runs the owner's chat unconfined at its level", async () => {
    await writeGatewayJson({ chat: { autonomy: "autonomous", backend: "host", allowUnconfined: true } });
    const gw = startGateway([bash("b1", "touch consented"), say("done")], [], { seams: { backend: undefined, confinement: async () => null } });
    await server.waitFor(() => server.commands.length > 0);
    await pairChat();
    server.pushMessage(CHAT, CHAT, "make a file");
    await server.waitFor(() => server.textsTo(CHAT).includes("done"));
    expect(keyboards(CHAT)).toHaveLength(0); // autonomous applies
    expect(await Bun.file(join(home, "workspace", "consented")).exists()).toBe(true); // on the host, in the project
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("a guest's chat runs commands only in Docker: without it, the guest is told so and nothing runs", async () => {
    await writeGatewayJson({ chat: { autonomy: "balanced", backend: "host", allowUnconfined: true } });
    const gw = startGateway([say("owner here")], [], { seams: { sandboxCheck: async () => "Docker isn't running" } });
    await server.waitFor(() => server.commands.length > 0);
    await pair(CHAT); // the owner
    await pair(GUEST);
    server.pushMessage(GUEST, GUEST, "hi");
    await server.waitFor(() => server.textsTo(GUEST).some((t) => t.includes("commands from this chat need Docker on the owner's machine")));
    expect(gw.model.requests).toHaveLength(0);
    // The owner's chat is on the host and doesn't need Docker.
    server.pushMessage(CHAT, CHAT, "hi");
    await server.waitFor(() => server.textsTo(CHAT).includes("owner here"));
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("a guest's chat asks even when the project is autonomous, and so does its subagent; the owner's and its subagent's don't", async () => {
    await writeGatewayJson({ chat: { autonomy: "autonomous", backend: "host" } });
    const gw = startGateway([
      // The owner: a command, then a subagent with a command of its own, all unasked.
      bash("o1", "ls"),
      subagent("o2"),
      bash("o3", "ls -a"),
      say("owner's subagent done"),
      say("owner done"),
      // The guest: the same, and each command asks.
      bash("g1", "ls"),
      subagent("g2"),
      bash("g3", "ls -a"),
      say("guest's subagent done"),
      say("guest done"),
    ]);
    await server.waitFor(() => server.commands.length > 0);
    await pair(CHAT); // the first approval is the owner
    await pair(GUEST);

    server.pushMessage(CHAT, CHAT, "look around");
    await server.waitFor(() => server.textsTo(CHAT).includes("owner done"));
    expect(keyboards(CHAT)).toHaveLength(0);
    expect(resultIn(gw.model, 3)).toContain("README.md"); // the subagent's ls -a ran

    server.pushMessage(GUEST, GUEST, "look around");
    expect(await approve(GUEST, 1)).toContain("ls");
    expect(await approve(GUEST, 2)).toContain("ls -a"); // the subagent's command
    await server.waitFor(() => server.textsTo(GUEST).includes("guest done"));
    expect(keyboards(GUEST)).toHaveLength(2);
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("a gateway.json broken mid-turn keeps the last good settings: the turn's next command is still judged at balanced", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gw = startGateway([async () => (await gate, reply([toolUseBlock("b1", "Bash", { command: "ls" })], "tool_use")), say("one")]);
    const info = await gw.running();
    await server.waitFor(() => server.commands.length > 0);
    await pairChat();
    server.pushMessage(CHAT, CHAT, "list the files");
    await server.waitFor(() => gw.model.requests.length === 1);
    // The file breaks while the turn runs, and a reload reads it: the live settings stay the last good ones.
    await Bun.write(join(home, "gateway.json"), "{not json");
    await info.reload();
    expect(gw.err.join("")).toContain("keeping the last good settings");
    release();
    await server.waitFor(() => server.textsTo(CHAT).includes("one"));
    expect(keyboards(CHAT)).toHaveLength(0); // ls was decided with the file broken, at balanced
    expect(resultIn(gw.model, 1)).toContain("README.md");
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  /** Opens a scheduled run's session as the job runner does: nobody is there, so whatever still asks is denied. */
  async function scheduledRun(deps: GatewayServiceDeps) {
    const session = await deps.openSession("default");
    const asked: string[] = [];
    session.attach({
      event: () => {},
      ask: (id, prompt) => {
        asked.push(String((prompt.input as { command?: unknown }).command));
        session.answer(id, { kind: "deny", message: "No one is here to approve this scheduled run." });
      },
      askClosed: () => {},
      state: () => {},
    });
    return { session, asked };
  }

  function startWithProbe(steps: Step[]) {
    let deps: GatewayServiceDeps | undefined;
    const service: GatewayService = { name: "probe", start: async (d) => void (deps = d), stop: async () => {} };
    const gw = startGateway(steps, [service]);
    return { gw, deps: async () => (await gw.running(), deps!) };
  }

  test("a scheduled run uses the project's level: at balanced, a read-only command runs and an install is denied", async () => {
    const { gw, deps } = startWithProbe([bash("b1", "ls"), bash("b2", "npm install left-pad"), say("done")]);
    const { session, asked } = await scheduledRun(await deps());
    expect(await session.prompt("check the project")).toBe("end_turn");
    expect(asked).toEqual(["npm install left-pad"]);
    expect(resultIn(gw.model, 1)).toContain("README.md");
    expect(resultIn(gw.model, 2)).toContain("The user declined this action");
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("a scheduled run at ask: everything that would ask is denied, a read-only command too", async () => {
    await writeGatewayJson({ chat: { autonomy: "ask", backend: "host" } });
    const { gw, deps } = startWithProbe([bash("b1", "ls"), say("done")]);
    const { session, asked } = await scheduledRun(await deps());
    expect(await session.prompt("check the project")).toBe("end_turn");
    expect(asked).toEqual(["ls"]);
    expect(resultIn(gw.model, 1)).toContain("The user declined this action");
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("a scheduled run at autonomous: a command in the project runs unasked", async () => {
    await writeGatewayJson({ chat: { autonomy: "autonomous", backend: "host" } });
    const { gw, deps } = startWithProbe([bash("b1", "touch by-the-job"), say("done")]);
    const { session, asked } = await scheduledRun(await deps());
    expect(await session.prompt("make a file")).toBe("end_turn");
    expect(asked).toEqual([]);
    expect(await Bun.file(join(home, "workspace", "by-the-job")).exists()).toBe(true);
    gw.stop();
    expect(await gw.done).toBe(0);
  });
});
