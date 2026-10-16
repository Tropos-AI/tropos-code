// src/web/admin/ops-testkit.ts — test support for the admin area handlers: a throwaway Tropos home, and an admin
// dispatcher served over a real `startWebServer` WebSocket so end-to-end tests send raw `{t:"admin"}` messages.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeRuntime } from "../../../test/helpers/fake-runtime";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { createAdmin } from "./index";
import type { AdminContext, AdminHandlers } from "./context";
import { WebHost } from "../host";
import { startWebServer } from "../server";

export interface Kit {
  root: string;
  /** TROPOS_HOME */
  home: string;
  userHome: string;
  ctx: AdminContext;
  /** Moves the fake clock. */
  clock: { now: number };
  cleanup(): Promise<void>;
}

export async function makeKit(over: Partial<AdminContext> = {}): Promise<Kit> {
  const root = await makeTmpDir("admin-ops-");
  const userHome = join(root, "home");
  const home = join(userHome, ".tropos");
  await mkdir(home, { recursive: true });
  const clock = { now: Date.parse("2026-10-15T12:00:00Z") };
  const ctx: AdminContext = {
    home,
    userHome,
    env: { HOME: userHome, PATH: process.env.PATH },
    version: "1.2.3",
    execPath: join(root, "bin", "tcode"),
    cwd: root,
    now: () => clock.now,
    fetch: (async () => {
      throw new Error("network is not available in tests");
    }) as unknown as typeof fetch,
    ...over,
  };
  return { root, home, userHome, ctx, clock, cleanup: () => removeDir(root) };
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

const TOKEN = "ops-testkit-token-1234567890";

export interface WsAdmin {
  /** Sends `{t:"admin"}` and resolves with the `admin_result` message as received. */
  call(method: string, params?: unknown): Promise<{ t: string; id: number; ok: boolean; result?: unknown; error?: string }>;
  close(): Promise<void>;
}

/** The given handlers behind a real web server and a raw WebSocket client. */
export async function adminOverWs(ctx: AdminContext, handlers: AdminHandlers): Promise<WsAdmin> {
  const host = new WebHost(fakeRuntime([]));
  const server = await startWebServer({ host, admin: createAdmin(ctx, handlers), assets: new Map(), token: TOKEN, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { Cookie: `tcode_session=${TOKEN}`, Origin: base } } as unknown as string[]);
  const waiters = new Map<number, (m: never) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { t: string; id?: number };
    if (m.t === "admin_result" && m.id !== undefined) waiters.get(m.id)?.(m as never);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
  let id = 0;
  return {
    call(method, params) {
      const rid = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no admin_result for ${method}`)), 10_000);
        waiters.set(rid, ((m: never) => {
          clearTimeout(timer);
          resolve(m);
        }) as never);
        ws.send(JSON.stringify({ t: "admin", id: rid, method, params }));
      });
    },
    async close() {
      ws.close();
      await server.stop();
    },
  };
}
