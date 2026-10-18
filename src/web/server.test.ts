// src/web/server.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { openAuthed, rawLogin, rawSocket, testAccess } from "../../test/helpers/web-client";
import { assetsFromDir, type AssetMap } from "./assets";
import { DeviceStore, devicesPath, type Device } from "./devices";
import { WebHost } from "./host";
import { GLOBAL_MAX_FAILURES, type LoginCodes } from "./login-codes";
import type { ChatHost } from "./project-hosts";
import { AUTH_CLOSE_CODE, type ServerMessage } from "./protocol";
import { PortInUseError } from "./port";
import { parseClientMessage, startWebServer, type AdminDispatcher, type RunningWebServer } from "./server";

let dir: string;
let assets: AssetMap;
let server: RunningWebServer | null = null;
let devices: DeviceStore;
let logins: LoginCodes;
let key: string;

beforeEach(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><title>app</title>");
  await writeFile(join(dir, "assets", "app-abc.js"), "console.info('app')");
  assets = assetsFromDir(dir);
  ({ devices, logins, key } = await testAccess(join(dir, "home")));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  await removeDir(dir);
});

interface StartOptions {
  dev?: boolean;
  assets?: AssetMap;
  admin?: AdminDispatcher;
  remoteHost?: () => string | null;
  /** Wraps the chat host, to see what reaches it. */
  wrap?: (host: ChatHost) => ChatHost;
  devices?: DeviceStore;
}

async function start(steps: Step[] = [], over: StartOptions = {}) {
  const runtime = fakeRuntime(steps);
  const host = new WebHost(runtime);
  server = await startWebServer({
    host: over.wrap ? over.wrap(host) : host,
    admin: over.admin,
    assets: over.assets ?? assets,
    devices: over.devices ?? devices,
    logins,
    port: 0,
    dev: over.dev,
    remoteHost: over.remoteHost,
  });
  return { runtime, host, server, base: `http://127.0.0.1:${server.port}` };
}

/** A logged-in tab with an RPC helper. */
async function connect(base: string, origin = base) {
  const socket = await openAuthed(base, key, origin);
  let id = 0;
  const rpc = async (method: string, params?: unknown) => {
    const rid = ++id;
    socket.send({ t: "rpc", id: rid, method, params });
    return socket.next((m) => m.t === "rpc_result" && m.id === rid, 5000) as Promise<Extract<ServerMessage, { t: "rpc_result" }>>;
  };
  return { ...socket, rpc };
}

const upgradeHeaders = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };

describe("HTTP", () => {
  test("a foreign Host is refused (DNS rebinding)", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`, { headers: { Host: "evil.example" } });
    expect(res.status).toBe(421);
  });

  test("the app shell and assets are public; there is no ?token= or /auth any more", async () => {
    const { base } = await start();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>app</title>");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect((await fetch(`${base}/assets/app-abc.js`)).status).toBe(200);
    // Ignored: the shell, with no cookie and no redirect.
    const old = await fetch(`${base}/?token=x`, { redirect: "manual" });
    expect(old.status).toBe(200);
    expect(old.headers.get("set-cookie")).toBeNull();
    const auth = await fetch(`${base}/auth?token=x`, { redirect: "manual" });
    expect(auth.status).toBe(200);
    expect(auth.headers.get("set-cookie")).toBeNull();
  });

  test("assets, the app for client routes, 404 for missing files, GET only", async () => {
    const { base } = await start();
    const js = await fetch(`${base}/assets/app-abc.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    const route = await fetch(`${base}/skills`);
    expect(await route.text()).toContain("<title>app</title>");
    expect(route.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });

  test("an unbuilt web app says how to build it", async () => {
    const { base } = await start([], { assets: new Map() });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("bun run build:web");
  });

  test("the address it reports is http://localhost:<port>/, with nothing secret in it", async () => {
    const { server } = await start();
    expect(server.url).toBe(`http://localhost:${server.port}/`);
  });
});

describe("logging in", () => {
  /** A chat host that records whether anything reached it. */
  const spyHost = (calls: string[]) => (host: ChatHost): ChatHost => ({
    attach: (send) => {
      calls.push("attach");
      return host.attach(send);
    },
    handle: (message, reply) => {
      calls.push(`handle:${message.t}`);
      return host.handle(message, reply);
    },
    shutdown: () => host.shutdown(),
  });

  test("a socket gets nothing until it authenticates; a bad key gets auth_failed and stays open for login", async () => {
    const calls: string[] = [];
    const adminCalls: string[] = [];
    const admin: AdminDispatcher = { handle: async (method) => void adminCalls.push(method) };
    const { base } = await start([], { wrap: spyHost(calls), admin });
    const raw = rawSocket(base);
    raw.send({ t: "rpc", id: 1, method: "sessions" });
    raw.send({ t: "admin", id: 2, method: "status.get" });
    raw.send({ t: "permission", id: 3, answer: { kind: "allow" } });
    raw.send({ t: "auth", key: "nope" });
    expect(await raw.next((m) => m.t === "auth_failed")).toEqual({ t: "auth_failed" });
    // Still open: a login on the same socket is answered.
    raw.send({ t: "login", value: "123456", name: "x" });
    expect(await raw.next((m) => m.t === "login_failed")).toEqual({ t: "login_failed", reason: "invalid" });
    expect(raw.messages.map((m) => m.t)).toEqual(["auth_failed", "login_failed"]);
    expect(calls).toEqual([]);
    expect(adminCalls).toEqual([]);
    raw.ws.close();
  });

  test("auth with a device key: auth_ok, then hello", async () => {
    const { base } = await start();
    const [device] = await devices.list();
    const tab = await openAuthed(base, key);
    await tab.next((m) => m.t === "state");
    expect(tab.messages[0]).toEqual({ t: "auth_ok", device: { id: device!.id, name: "Test browser" } });
    expect(tab.messages[1]?.t).toBe("hello");
    expect(JSON.stringify(tab.messages)).not.toContain(key);
    tab.ws.close();
  });

  test("login with a 6-digit code creates a device and returns its key once; the code then fails", async () => {
    const { base } = await start();
    const code = await logins.issueCode();
    const ok = await rawLogin(base, `${code.slice(0, 3)} ${code.slice(3)}`, "Safari on iPhone");
    expect(ok).toMatchObject({ t: "login_ok", device: { name: "Safari on iPhone" } });
    const list = await devices.list();
    expect(list.length).toBe(2);
    expect(list.find((d) => d.name === "Safari on iPhone")).toMatchObject({ via: "local" });
    // The returned key is the new device's: it authenticates.
    const tab = await openAuthed(base, (ok as Extract<ServerMessage, { t: "login_ok" }>).key);
    tab.ws.close();
    expect(await rawLogin(base, code, "x")).toEqual({ t: "login_failed", reason: "invalid" });
  });

  test("login with a one-time key logs in and attaches the tab; the name is cleaned", async () => {
    const { base } = await start();
    const once = await logins.issueOneTime();
    const raw = rawSocket(base);
    raw.send({ t: "login", value: once, name: "Chrome\u0000 on   Mac" });
    const ok = (await raw.next((m) => m.t === "login_ok")) as Extract<ServerMessage, { t: "login_ok" }>;
    expect(ok.device.name).toBe("Chrome on Mac");
    expect(ok.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await raw.next((m) => m.t === "hello")).toBeTruthy();
    raw.ws.close();
  });

  test("login while locked says so", async () => {
    const { base } = await start();
    const raw = rawSocket(base);
    for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) {
      raw.send({ t: "login", value: String(100000 + i), name: "x" });
      await raw.next((m) => m.t === "login_failed" && raw.messages.length === i + 1);
    }
    const good = await logins.issueCode();
    raw.send({ t: "login", value: good, name: "x" });
    await raw.next((m) => raw.messages.length === GLOBAL_MAX_FAILURES + 1);
    expect(raw.messages.at(-1)).toEqual({ t: "login_failed", reason: "locked" });
    expect((await devices.list()).length).toBe(1);
    raw.ws.close();
  });

  test("revoked device: recheckDevices closes its socket with 4401", async () => {
    const { base, server } = await start();
    const other = await devices.create("Other");
    const keep = await openAuthed(base, other.key);
    const gone = await openAuthed(base, key);
    const [mine] = (await devices.list()).filter((d) => d.name === "Test browser");
    await devices.revoke(mine!.id);
    await server.recheckDevices();
    expect(await gone.closed).toBe(AUTH_CLOSE_CODE);
    expect(AUTH_CLOSE_CODE).toBe(4401);
    // The other device's tab is untouched and still served.
    keep.send({ t: "rpc", id: 9, method: "sessions" });
    expect(await keep.next((m) => m.t === "rpc_result" && m.id === 9)).toMatchObject({ ok: true });
    keep.ws.close();
  });

  test("admin calls carry the caller's device id", async () => {
    const seen: unknown[] = [];
    const admin: AdminDispatcher = {
      handle: async (method, params, caller) => {
        seen.push({ method, params, caller });
        return { fine: true };
      },
    };
    const { base } = await start([], { admin });
    const [device] = await devices.list();
    const tab = await openAuthed(base, key);
    tab.send({ t: "admin", id: 4, method: "status.get", params: { a: 1 } });
    expect(await tab.next((m) => m.t === "admin_result")).toEqual({ t: "admin_result", id: 4, ok: true, result: { fine: true } });
    expect(seen).toEqual([{ method: "status.get", params: { a: 1 }, caller: { deviceId: device!.id } }]);
    tab.ws.close();
  });

  test("a socket that closes while its key is checked is not attached", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let checked!: () => void;
    const verified = new Promise<void>((r) => (checked = r));
    let asked!: () => void;
    const started = new Promise<void>((r) => (asked = r));
    class SlowStore extends DeviceStore {
      override async verify(k: string, via?: Device["via"]) {
        asked();
        await gate;
        try {
          return await super.verify(k, via);
        } finally {
          checked();
        }
      }
    }
    const calls: string[] = [];
    const { base } = await start([], { wrap: spyHost(calls), devices: new SlowStore({ path: devicesPath(join(dir, "home")) }) });
    const raw = rawSocket(base);
    raw.send({ t: "auth", key });
    // Close while the server is checking the key.
    await started;
    raw.ws.close();
    await raw.closed;
    open();
    await verified;
    // A round trip later the server has finished with the closed socket.
    await fetch(base);
    expect(calls).toEqual([]);
  });
});

describe("Host and Origin", () => {
  const remote = "mac.tail1.ts.net";

  test("loopback names only, without remote access", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/`, { headers: { Host: remote } })).status).toBe(421);
    expect((await fetch(`${base}/`, { headers: { Host: `localhost:${new URL(base).port}` } })).status).toBe(200);
    expect((await fetch(`${base}/ws`, { headers: { ...upgradeHeaders, Origin: `https://${remote}` } })).status).toBe(403);
    // The switch can be on but the name unknown yet: still loopback only.
    const off = await start([], { remoteHost: () => null });
    expect((await fetch(`${off.base}/`, { headers: { Host: remote } })).status).toBe(421);
  });

  test("with remote access: exactly that host and https origin; via is tailscale", async () => {
    let name: string | null = remote;
    const { base } = await start([], { remoteHost: () => name });
    expect((await fetch(`${base}/`, { headers: { Host: remote } })).status).toBe(200);
    expect((await fetch(`${base}/`, { headers: { Host: "evil.ts.net" } })).status).toBe(421);
    expect((await fetch(`${base}/`, { headers: { Host: `${remote}.evil.example` } })).status).toBe(421);
    expect((await fetch(`${base}/ws`, { headers: { ...upgradeHeaders, Origin: `http://${remote}` } })).status).toBe(403);
    const code = await logins.issueCode();
    const ok = await rawLogin(base, code, "Phone", `https://${remote}`);
    expect(ok).toMatchObject({ t: "login_ok" });
    expect((await devices.list()).find((d) => d.name === "Phone")?.via).toBe("tailscale");
    // Turned off: the name is refused again at once.
    name = null;
    expect((await fetch(`${base}/`, { headers: { Host: remote } })).status).toBe(421);
    expect((await fetch(`${base}/ws`, { headers: { ...upgradeHeaders, Origin: `https://${remote}` } })).status).toBe(403);
  });
});

describe("WebSocket", () => {
  test("refused from another origin or without an upgrade", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/ws`, { headers: { ...upgradeHeaders } })).status).toBe(403);
    expect((await fetch(`${base}/ws`, { headers: { ...upgradeHeaders, Origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/ws`, { headers: { Origin: base } })).status).toBe(400);
  });

  test("dev mode also accepts the Vite dev server's origin", async () => {
    const { base } = await start([], { dev: true });
    const c = await connect(base, "http://localhost:5173");
    expect((await c.next((m) => m.t === "hello")).t).toBe("hello");
    c.ws.close();
  });

  test("a tab gets hello and state; a prompt streams events to every tab and resolves at the end of the turn", async () => {
    const { base } = await start([() => reply([textBlock("Hello from the agent")])]);
    const a = await connect(base);
    const b = await connect(base);
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
    const a = await connect(base);
    const b = await connect(base);
    const turn = a.rpc("prompt", { text: "build" });
    const ask = (await b.next((m) => m.t === "ask")) as Extract<ServerMessage, { t: "ask" }>;
    expect(ask.prompt.toolName).toBe("Shell");
    // A tab that connects now still sees the open prompt.
    const late = await connect(base);
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
    const a = await connect(base);
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
    const a = await connect(base);
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

test("parseClientMessage: auth needs a key of at most 128 characters, login a value (128) and a name (200)", () => {
  expect(parseClientMessage(JSON.stringify({ t: "auth", key: "k".repeat(128) }))).toEqual({ t: "auth", key: "k".repeat(128) });
  expect(parseClientMessage(JSON.stringify({ t: "auth", key: "k".repeat(129) }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ t: "auth", key: 5 }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ t: "auth" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ t: "login", value: "123456", name: "Phone" }))).toEqual({ t: "login", value: "123456", name: "Phone" });
  expect(parseClientMessage(JSON.stringify({ t: "login", value: "1".repeat(129), name: "Phone" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ t: "login", value: "123456", name: "n".repeat(201) }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ t: "login", value: "123456" }))).toBeNull();
  // Only the known fields travel on.
  expect(parseClientMessage(JSON.stringify({ t: "auth", key: "k", extra: 1 }))).toEqual({ t: "auth", key: "k" });
});

test("a taken port throws PortInUseError instead of moving", async () => {
  const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
  try {
    const host = new WebHost(fakeRuntime([]));
    const err = await startWebServer({ host, assets, devices, logins, port: blocker.port! }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortInUseError);
    expect((err as PortInUseError).port).toBe(blocker.port!);
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
