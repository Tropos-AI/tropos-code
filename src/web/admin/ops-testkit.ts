// src/web/admin/ops-testkit.ts — test support for the admin area handlers: a throwaway Tropos home, and an admin
// dispatcher served over a real `startWebServer` WebSocket so end-to-end tests send raw `{t:"admin"}` messages.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeRuntime } from "../../../test/helpers/fake-runtime";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { openAuthed, testAccess } from "../../../test/helpers/web-client";
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

export interface WsAdmin {
  /** Sends `{t:"admin"}` and resolves with the `admin_result` message as received. */
  call(method: string, params?: unknown): Promise<{ t: string; id: number; ok: boolean; result?: unknown; error?: string }>;
  close(): Promise<void>;
}

/** The given handlers behind a real web server and a logged-in WebSocket client. */
export async function adminOverWs(ctx: AdminContext, handlers: AdminHandlers): Promise<WsAdmin> {
  const host = new WebHost(fakeRuntime([]));
  // The login state lives outside the kit's home, so the handlers under test never see it.
  const accessDir = await makeTmpDir("admin-ops-access-");
  const { devices, logins, key } = await testAccess(accessDir);
  const server = await startWebServer({ host, admin: createAdmin(ctx, handlers), assets: new Map(), devices, logins, port: 0 });
  const socket = await openAuthed(`http://127.0.0.1:${server.port}`, key);
  let id = 0;
  return {
    async call(method, params) {
      const rid = ++id;
      socket.send({ t: "admin", id: rid, method, params });
      return (await socket.next((m) => m.t === "admin_result" && m.id === rid, 10_000)) as never;
    },
    async close() {
      socket.ws.close();
      await server.stop();
      await removeDir(accessDir);
    },
  };
}
