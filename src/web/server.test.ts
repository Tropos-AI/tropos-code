// src/web/server.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { assetsFromDir, type AssetMap } from "./assets";
import { WebHost } from "./host";
import type { ServerMessage } from "./protocol";
import { parseClientMessage, startWebServer, type RunningWebServer } from "./server";

const TOKEN = "secret-token-1234567890";
let dir: string;
let assets: AssetMap;
let server: RunningWebServer | null = null;

beforeEach(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><title>app</title>");
  await writeFile(join(dir, "assets", "app-abc.js"), "console.info('app')");
  assets = assetsFromDir(dir);
});
afterEach(async () => {
  await server?.stop();
  server = null;
  await removeDir(dir);
});

async function start(steps: Step[] = [], over: { dev?: boolean; assets?: AssetMap } = {}) {
  const runtime = fakeRuntime(steps);
  const host = new WebHost(runtime);
  server = await startWebServer({ host, assets: over.assets ?? assets, token: TOKEN, port: 0, dev: over.dev });
  return { runtime, host, base: `http://127.0.0.1:${server.port}` };
}

const cookie = `tcode_session=${TOKEN}`;

/** A WebSocket client that records every message and can wait for one. */
function connect(base: string, origin = base) {
  const messages: ServerMessage[] = [];
  const waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { Cookie: cookie, Origin: origin } } as unknown as string[]);
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMessage;
    messages.push(m);
    for (const w of [...waiters]) {
      if (w.match(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
  const next = (match: (m: ServerMessage) => boolean, timeout = 3000) => {
    const found = messages.find(match);
    if (found) return Promise.resolve(found);
    return new Promise<ServerMessage>((resolve, reject) => {
      waiters.push({ match, resolve });
      setTimeout(() => reject(new Error("timed out waiting for a message")), timeout);
    });
  };
  let id = 0;
  const rpc = async (method: string, params?: unknown) => {
    const rid = ++id;
    ws.send(JSON.stringify({ t: "rpc", id: rid, method, params }));
    return next((m) => m.t === "rpc_result" && m.id === rid, 5000) as Promise<Extract<ServerMessage, { t: "rpc_result" }>>;
  };
  return { ws, messages, opened, next, rpc, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe("HTTP", () => {
  test("a foreign Host is refused (DNS rebinding)", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`, { headers: { Host: "evil.example" } });
    expect(res.status).toBe(421);
  });

  test("without the cookie: a locked page with no scripts, and 401 for everything else", async () => {
    const { base } = await start();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(401);
    const html = await page.text();
    expect(html).toContain("tcode web");
    expect(html).not.toContain("<script");
    expect((await fetch(`${base}/assets/app-abc.js`)).status).toBe(401);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });

  test("the printed link sets an HttpOnly, SameSite=Strict cookie and drops the token from the address", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toBe(`tcode_session=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    expect((await fetch(`${base}/auth?token=wrong`, { redirect: "manual" })).status).toBe(401);
  });

  test("with the cookie: assets, the app for client routes, 404 for missing files, GET only", async () => {
    const { base } = await start();
    const js = await fetch(`${base}/assets/app-abc.js`, { headers: { Cookie: cookie } });
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    const route = await fetch(`${base}/skills`, { headers: { Cookie: cookie } });
    expect(await route.text()).toContain("<title>app</title>");
    expect(route.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${base}/missing.js`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await fetch(`${base}/`, { method: "POST", headers: { Cookie: cookie } })).status).toBe(405);
  });

  test("an unbuilt web app says how to build it", async () => {
    const { base } = await start([], { assets: new Map() });
    const res = await fetch(`${base}/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("bun run build:web");
  });
});

describe("WebSocket", () => {
  test("refused without the cookie or from another origin", async () => {
    const { base } = await start();
    const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
    expect((await fetch(`${base}/ws`, { headers: { ...headers, Origin: base } })).status).toBe(403);
    expect((await fetch(`${base}/ws`, { headers: { ...headers, Origin: "http://evil.example", Cookie: cookie } })).status).toBe(403);
    expect((await fetch(`${base}/ws`, { headers: { Origin: base, Cookie: cookie } })).status).toBe(400);
  });

  test("dev mode also accepts the Vite dev server's origin", async () => {
    const { base } = await start([], { dev: true });
    const c = connect(base, "http://localhost:5173");
    await c.opened;
    expect((await c.next((m) => m.t === "hello")).t).toBe("hello");
    c.ws.close();
  });

  test("a tab gets hello and state; a prompt streams events to every tab and resolves at the end of the turn", async () => {
    const { base } = await start([() => reply([textBlock("Hello from the agent")])]);
    const a = connect(base);
    const b = connect(base);
    await Promise.all([a.opened, b.opened]);
    const hello = (await a.next((m) => m.t === "hello")) as Extract<ServerMessage, { t: "hello" }>;
    expect(hello.server).toMatchObject({ version: "0.1.0-test", cwd: "/w", sessionId: "fake-session" });
    expect((await a.next((m) => m.t === "state")) as Extract<ServerMessage, { t: "state" }>).toMatchObject({ state: { busy: false, model: "claude-opus-5-5" } });
    const result = await a.rpc("prompt", { text: "hi", display: "hi there" });
    expect(result).toMatchObject({ ok: true, result: "end_turn" });
    await b.next((m) => m.t === "user" && m.text === "hi there");
    // The sending tab shows its own prompt already; only the others are told.
    expect(a.messages.some((m) => m.t === "user")).toBe(false);
    expect(b.messages.some((m) => m.t === "state" && typeof m.state.turnStartedAt === "number")).toBe(true);
    await b.next((m) => m.t === "event" && m.event.type === "turn_end");
    expect(b.messages.some((m) => m.t === "event" && m.event.type === "text")).toBe(true);
    expect(b.messages.some((m) => m.t === "state" && m.state.busy)).toBe(true);
    a.ws.close();
    b.ws.close();
  });

  test("permission prompts go to every tab; the first answer wins and the prompt closes everywhere", async () => {
    const steps: Step[] = [() => reply([toolUseBlock("t1", "Shell", { command: "make" })], "tool_use"), () => reply([textBlock("built")])];
    const { base } = await start(steps);
    const a = connect(base);
    const b = connect(base);
    await Promise.all([a.opened, b.opened]);
    const turn = a.rpc("prompt", { text: "build" });
    const ask = (await b.next((m) => m.t === "ask")) as Extract<ServerMessage, { t: "ask" }>;
    expect(ask.prompt.toolName).toBe("Shell");
    // A tab that connects now still sees the open prompt.
    const late = connect(base);
    await late.opened;
    await late.next((m) => m.t === "ask" && m.id === ask.id);
    b.send({ t: "permission", id: ask.id, answer: { kind: "allow" } });
    await a.next((m) => m.t === "ask_closed" && m.id === ask.id);
    expect(await turn).toMatchObject({ ok: true, result: "end_turn" });
    expect(a.messages.some((m) => m.t === "event" && m.event.type === "tool_end" && m.event.status === "done")).toBe(true);
    for (const c of [a, b, late]) c.ws.close();
  });

  test("a second prompt during a turn is refused; interrupt stops the turn", async () => {
    const hang: Step = (_req, _h, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const { base } = await start([hang]);
    const a = connect(base);
    await a.opened;
    const turn = a.rpc("prompt", { text: "work" });
    await a.next((m) => m.t === "state" && m.state.busy);
    expect(await a.rpc("prompt", { text: "more" })).toMatchObject({ ok: false, error: "busy" });
    expect(await a.rpc("clear")).toMatchObject({ ok: false });
    await a.rpc("interrupt");
    expect(await turn).toMatchObject({ ok: true, result: "aborted" });
    a.ws.close();
  });

  test("bad requests get an error, garbage is ignored", async () => {
    const { base } = await start();
    const a = connect(base);
    await a.opened;
    expect(await a.rpc("nope")).toMatchObject({ ok: false, error: "Unknown request." });
    expect(await a.rpc("prompt", { text: "  " })).toMatchObject({ ok: false, error: "Nothing to send." });
    a.ws.send("not json");
    expect(await a.rpc("setModel", "claude-sonnet-5-5")).toMatchObject({ ok: true });
    a.ws.close();
  });
});

test("parseClientMessage accepts only well-formed messages", () => {
  expect(parseClientMessage('{"t":"rpc","id":1,"method":"clear"}')).toMatchObject({ t: "rpc" });
  expect(parseClientMessage('{"t":"permission","id":2,"answer":{"kind":"allow"}}')).toMatchObject({ t: "permission" });
  expect(parseClientMessage('{"t":"permission","id":2,"answer":{"kind":"sudo"}}')).toBeNull();
  expect(parseClientMessage('{"t":"rpc","id":"x","method":"clear"}')).toBeNull();
  expect(parseClientMessage("[]")).toBeNull();
  expect(parseClientMessage("{")).toBeNull();
  expect(parseClientMessage(Buffer.from("x".repeat(1024 * 1024 + 1)))).toBeNull();
});

test("a taken port falls back to a free one", async () => {
  const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
  try {
    const host = new WebHost(fakeRuntime([]));
    server = await startWebServer({ host, assets, token: TOKEN, port: blocker.port! });
    expect(server.port).not.toBe(blocker.port);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${TOKEN}`);
  } finally {
    blocker.stop(true);
  }
});

describe("admin messages", () => {
  test("parseClientMessage accepts a well-formed admin call and nothing else shaped like one", () => {
    expect(parseClientMessage(JSON.stringify({ t: "admin", id: 3, method: "status.get" }))).toEqual({ t: "admin", id: 3, method: "status.get" });
    expect(parseClientMessage(JSON.stringify({ t: "admin", id: "3", method: "status.get" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "admin", id: 3, method: 7 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "admin", id: 3, method: "x".repeat(65) }))).toBeNull();
  });
});
