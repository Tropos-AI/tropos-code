// test/helpers/web-client.ts — WebSocket clients for the dashboard server: raw (nothing sent yet) and logged in with a device key.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DeviceStore, devicesPath } from "../../src/web/devices";
import { loginCodesFor, type LoginCodes } from "../../src/web/login-codes";
import { WS_PATH, type ServerMessage } from "../../src/web/protocol";

export interface TestSocket {
  ws: WebSocket;
  /** Every message received so far, in order. */
  messages: ServerMessage[];
  /** Resolves with the first message (already received or still to come) that matches. */
  next(match: (m: ServerMessage) => boolean, timeout?: number): Promise<ServerMessage>;
  /** Calls `fn` for every message received so far, then for each new one. */
  onMessage(fn: (m: ServerMessage) => void): void;
  /** Sends once the socket is open, in call order. */
  send(message: unknown): void;
  opened: Promise<void>;
  /** Resolves with the close code. */
  closed: Promise<number>;
}

/** A socket that has sent nothing: it must authenticate or log in before it gets anything. */
export function rawSocket(base: string, origin: string = base): TestSocket {
  const messages: ServerMessage[] = [];
  const listeners: Array<(m: ServerMessage) => void> = [];
  const waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}${WS_PATH}`, { headers: { Origin: origin } } as unknown as string[]);
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as ServerMessage;
    messages.push(m);
    for (const w of [...waiters]) {
      if (w.match(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
    for (const fn of listeners) fn(m);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  const next = (match: (m: ServerMessage) => boolean, timeout = 3000) => {
    const found = messages.find(match);
    if (found) return Promise.resolve(found);
    return new Promise<ServerMessage>((resolve, reject) => {
      waiters.push({ match, resolve });
      setTimeout(() => reject(new Error("timed out waiting for a message")), timeout);
    });
  };
  return {
    ws,
    messages,
    next,
    onMessage(fn) {
      for (const m of messages) fn(m);
      listeners.push(fn);
    },
    send(message) {
      void opened.then(() => ws.send(JSON.stringify(message)));
    },
    opened,
    closed,
  };
}

/** A socket that authenticated with a device key (resolves after `auth_ok`; `hello` follows). */
export async function openAuthed(base: string, key: string, origin: string = base): Promise<TestSocket> {
  const socket = rawSocket(base, origin);
  await socket.opened;
  socket.send({ t: "auth", key });
  const answer = await socket.next((m) => m.t === "auth_ok" || m.t === "auth_failed");
  if (answer.t !== "auth_ok") throw new Error("the device key was refused");
  return socket;
}

/** Sends one `login` on a fresh socket and returns the answer (`login_ok` or `login_failed`). */
export async function rawLogin(base: string, value: string, name: string, origin: string = base): Promise<ServerMessage> {
  const socket = rawSocket(base, origin);
  socket.send({ t: "login", value, name });
  try {
    return await socket.next((m) => m.t === "login_ok" || m.t === "login_failed");
  } finally {
    socket.ws.close();
  }
}

/** A device store and login codes under `dir` (as a Tropos home), with one device already logged in. */
export async function testAccess(dir: string): Promise<{ devices: DeviceStore; logins: LoginCodes; key: string }> {
  await mkdir(join(dir, "gateway"), { recursive: true });
  const devices = new DeviceStore({ path: devicesPath(dir) });
  const { key } = await devices.create("Test browser");
  return { devices, logins: loginCodesFor(dir), key };
}
