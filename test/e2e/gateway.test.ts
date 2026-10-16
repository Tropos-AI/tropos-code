// test/e2e/gateway.test.ts — `tcode gateway` end to end: a Telegram message, pairing, a session, Bash through the
// sandbox backend, and the Approve button. The model and Telegram are fakes; everything between them is real.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dockerCheck } from "../../src/gateway/daemon";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel, reply, textBlock, toolUseBlock, type Step } from "../helpers/fake-model";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { main } from "../../src/cli/main";
import { localBackend } from "../../src/exec/local";
import type { ExecBackend, ExecSpawn } from "../../src/exec/backend";
import { FakeTelegramServer } from "../helpers/telegram-fake-server";
import { TelegramApi } from "../../src/gateway/telegram/api";

const CHAT = 4242;

let dir: string;
let project: string;
let home: string;
let server: FakeTelegramServer;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-e2e");
  project = join(dir, "project");
  home = join(dir, "home");
  await mkdir(project);
  server = new FakeTelegramServer();
});
afterEach(async () => {
  server.stop();
  await removeDir(dir);
});

/** The local backend, recording what it was asked to run: proof that Bash goes through ctx.exec. */
function spyBackend() {
  return {
    kind: "local" as const,
    ran: [] as string[],
    closed: 0,
    spawn(o: ExecSpawn): ChildProcess {
      this.ran.push(o.script);
      return localBackend.spawn(o);
    },
    cwdMarker: (id: string) => localBackend.cwdMarker(id),
    signal: (child: ChildProcess, sig: NodeJS.Signals) => localBackend.signal(child, sig),
    alive: (child: ChildProcess) => localBackend.alive(child),
    async close() {
      this.closed++;
    },
  } satisfies ExecBackend & { ran: string[]; closed: number };
}

function startGateway(steps: Step[], opts: { sandboxProblem?: string; backend?: ExecBackend; realDocker?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const model = new FakeModel(steps);
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const backends: ExecBackend[] = [];
  const done = main(["gateway", "--no-web", "--workspace", project], {
    model,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { TROPOS_HOME: home, SHELL: "/bin/bash", TROPOS_TELEGRAM_BOT_TOKEN: server.token },
    cwd: project,
    gatewayUntil: () => stopped,
    gatewaySeams: {
      sweep: false,
      ...(opts.realDocker
        ? {}
        : {
            sandboxCheck: async () => opts.sandboxProblem,
            backend: () => {
              const b = opts.backend ?? spyBackend();
              backends.push(b);
              return b;
            },
          }),
      telegramApi: new TelegramApi({ token: server.token, baseUrl: server.baseUrl, sleep: async () => {} }),
      telegramOptions: { minIntervalMs: 0, pollTimeoutSec: 1, askTimeoutMs: 5_000 },
      assets: new Map(),
    },
  });
  return { done, stop, out, err, model, backends };
}

const pair = async (code: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await main(["pairing", "approve", "telegram", code], { out: (s) => out.push(s), err: (s) => err.push(s), env: { TROPOS_HOME: home }, cwd: project });
  return { exit, out: out.join(""), err: err.join("") };
};

const codeFrom = (text: string) => /approve telegram ([A-Z0-9]{8})/.exec(text)?.[1] ?? "";

const dockerProblem = await dockerCheck()();

describe("tcode gateway", () => {
  test("a stranger is paired by the owner, then a chat runs a sandboxed command after Approve", async () => {
    const gw = startGateway([
      () => reply([toolUseBlock("t1", "Bash", { command: "echo from-the-sandbox > made.txt && cat made.txt" })], "tool_use"),
      () => reply([textBlock("All done: the file says from-the-sandbox.")]),
    ]);
    await server.waitFor(() => server.commands.length > 0);

    // 1. Not approved: they get a code, and their message goes nowhere.
    server.pushMessage(CHAT, CHAT, "please run my build");
    await server.waitFor(() => server.sent.length >= 1);
    const code = codeFrom(server.sent[0]!.text);
    expect(code).toHaveLength(8);
    expect(gw.model.requests).toHaveLength(0);

    // 2. The owner approves the code on the machine.
    expect((await pair(code)).exit).toBe(0);
    expect((await pair(code)).exit).toBe(1); // a code works once

    // 3. Now the chat works; Bash needs the owner's Approve.
    server.pushMessage(CHAT, CHAT, "make a file and show it");
    const ask = await server.waitFor(() => server.sent.find((m) => m.replyMarkup));
    expect(ask.text).toContain("echo from-the-sandbox");
    expect(ask.replyMarkup!.inline_keyboard.flat().map((b) => b.text)).toEqual(["Approve", "Deny"]);
    server.pushCallback(CHAT, CHAT, ask.messageId, ask.replyMarkup!.inline_keyboard[0]![0]!.callback_data);
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("All done")));

    // The command ran through the backend, not around it, and its effect is in the workspace.
    const backend = gw.backends[0] as ReturnType<typeof spyBackend>;
    expect(backend.ran.join("\n")).toContain("echo from-the-sandbox");
    expect(await readFile(join(project, "made.txt"), "utf8")).toBe("from-the-sandbox\n");

    // Nothing the chat did was saved as a standing permission.
    expect(await Bun.file(join(project, ".tropos", "settings.local.json")).exists()).toBe(false);

    gw.stop();
    expect(await gw.done).toBe(0);
    expect(backend.closed).toBe(1);
  });

  test("Deny means the command does not run", async () => {
    const gw = startGateway([
      () => reply([toolUseBlock("t1", "Bash", { command: "touch should-not-exist" })], "tool_use"),
      () => reply([textBlock("Understood, I won't.")]),
    ]);
    await server.waitFor(() => server.commands.length > 0);
    server.pushMessage(CHAT, CHAT, "hi");
    await server.waitFor(() => server.sent.length >= 1);
    await pair(codeFrom(server.sent[0]!.text));

    server.pushMessage(CHAT, CHAT, "touch a file");
    const ask = await server.waitFor(() => server.sent.find((m) => m.replyMarkup));
    server.pushCallback(CHAT, CHAT, ask.messageId, ask.replyMarkup!.inline_keyboard[0]![1]!.callback_data);
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("Understood")));

    expect((await readdir(project)).includes("should-not-exist")).toBe(false);
    gw.stop();
    await gw.done;
  });

  test("a chat can't read outside the workspace, even if the model tries and the owner would approve", async () => {
    const secret = join(dir, "secret.txt");
    await Bun.write(secret, "top secret");
    const gw = startGateway([
      () => reply([toolUseBlock("t1", "Read", { file_path: secret })], "tool_use"),
      () => reply([textBlock("That was refused.")]),
    ]);
    await server.waitFor(() => server.commands.length > 0);
    server.pushMessage(CHAT, CHAT, "hi");
    await server.waitFor(() => server.sent.length >= 1);
    await pair(codeFrom(server.sent[0]!.text));

    server.pushMessage(CHAT, CHAT, "read the secret");
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("refused")));

    // No approval was even offered, and the file's content never reached the model.
    expect(server.sent.some((m) => m.replyMarkup)).toBe(false);
    expect(JSON.stringify(gw.model.requests.at(-1)!.messages)).not.toContain("top secret");
    expect(JSON.stringify(gw.model.requests.at(-1)!.messages)).toContain("confined to the workspace");
    gw.stop();
    await gw.done;
  });

  test("a symlink inside the workspace that points outside doesn't open the way out", async () => {
    const secret = join(dir, "outside-secret.txt");
    await Bun.write(secret, "top secret");
    await symlink(secret, join(project, "innocent.txt"));
    const gw = startGateway([
      () => reply([toolUseBlock("t1", "Read", { file_path: join(project, "innocent.txt") })], "tool_use"),
      () => reply([textBlock("Blocked.")]),
    ]);
    await server.waitFor(() => server.commands.length > 0);
    server.pushMessage(CHAT, CHAT, "hi");
    await server.waitFor(() => server.sent.length >= 1);
    await pair(codeFrom(server.sent[0]!.text));

    server.pushMessage(CHAT, CHAT, "read innocent.txt");
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("Blocked.")));
    expect(server.sent.some((m) => m.replyMarkup)).toBe(false);
    expect(JSON.stringify(gw.model.requests.at(-1)!.messages)).not.toContain("top secret");
    gw.stop();
    await gw.done;
  });

  test("a scheduled job runs in a sandboxed session and its result is delivered to the chat", async () => {
    await mkdir(join(home, "gateway", "cron"), { recursive: true });
    const soon = Date.now() + 700;
    await Bun.write(
      join(home, "gateway", "cron", "jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "job-1",
            name: "morning",
            schedule: { kind: "at", at: new Date(soon).toISOString() },
            prompt: "say hello to the team",
            project: "default",
            deliver: `telegram:${CHAT}`,
            enabled: true,
            createdAt: Date.now(),
            createdBy: "user",
            nextRunAt: soon,
          },
        ],
      }),
    );
    const gw = startGateway([() => reply([textBlock("Hello team, all quiet.")])]);
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("morning") && t.includes("Hello team, all quiet.")), 8_000);
    // Nobody paired: the delivery goes to the chat the job names, and the run is on record.
    const runs = (await readFile(join(home, "gateway", "cron", "runs.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { jobId: string; status: string });
    expect(runs).toEqual([expect.objectContaining({ jobId: "job-1", status: "ok" })]);
    expect(gw.backends).toHaveLength(1); // its Bash would have gone through the sandbox backend
    gw.stop();
    expect(await gw.done).toBe(0);
  });

  test("with the sandbox unavailable the chat is told so and nothing runs", async () => {
    const gw = startGateway([], { sandboxProblem: "Docker isn't running" });
    await server.waitFor(() => server.commands.length > 0);
    server.pushMessage(CHAT, CHAT, "hi");
    await server.waitFor(() => server.sent.length >= 1);
    await pair(codeFrom(server.sent[0]!.text));

    server.pushMessage(CHAT, CHAT, "run something");
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("sandbox isn't available")));
    expect(server.textsTo(CHAT).join("\n")).toContain("Docker isn't running");
    expect(gw.model.requests).toHaveLength(0);
    gw.stop();
    await gw.done;
  });

  test("without a token it still starts, says so, and cleans up its state file on exit", async () => {
    const out: string[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const done = main(["gateway", "--no-web"], {
      model: new FakeModel([]),
      out: (s) => out.push(s),
      err: () => {},
      env: { TROPOS_HOME: home, SHELL: "/bin/bash" },
      cwd: project,
      gatewayUntil: () => stopped,
      gatewaySeams: { sweep: false, assets: new Map() },
    });
    await server.waitFor(() => out.join("").includes("channels: none"));
    expect((await stat(join(home, "gateway", "state.json"))).isFile()).toBe(true);
    stop();
    expect(await done).toBe(0);
    expect(await Bun.file(join(home, "gateway", "state.json")).exists()).toBe(false);
  });

  test.skipIf(dockerProblem !== undefined)("with the real Docker sandbox: the chat's command sees the workspace and nothing of the host", async () => {
    process.env.GATEWAY_E2E_HOST_SECRET = "host-only-value";
    try {
      const gw = startGateway(
        [
          () => reply([toolUseBlock("t1", "Bash", { command: "pwd; echo HOME=$HOME; echo SECRET=${GATEWAY_E2E_HOST_SECRET:-unset}; ls /Users 2>&1 | head -1; echo written > real.txt; cat real.txt" })], "tool_use"),
          () => reply([textBlock("inspected")]),
        ],
        { realDocker: true },
      );
      await server.waitFor(() => server.commands.length > 0);
      server.pushMessage(CHAT, CHAT, "hi");
      await server.waitFor(() => server.sent.length >= 1);
      await pair(codeFrom(server.sent[0]!.text));
      server.pushMessage(CHAT, CHAT, "look around");
      const ask = await server.waitFor(() => server.sent.find((m) => m.replyMarkup));
      server.pushCallback(CHAT, CHAT, ask.messageId, ask.replyMarkup!.inline_keyboard[0]![0]!.callback_data);
      await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("inspected")), 60_000);

      const seen = JSON.stringify(gw.model.requests.at(-1)!.messages);
      expect(seen).toContain(project); // pwd: the workspace, at the same path as on the host
      expect(seen).toContain("HOME=/tmp"); // not the user's home
      expect(seen).toContain("SECRET=unset"); // the host environment didn't come along
      expect(seen).toContain("No such file"); // /Users doesn't exist inside
      expect(await readFile(join(project, "real.txt"), "utf8")).toBe("written\n"); // but the workspace is shared
      gw.stop();
      expect(await gw.done).toBe(0);
    } finally {
      delete process.env.GATEWAY_E2E_HOST_SECRET;
    }
  }, 90_000);
});
