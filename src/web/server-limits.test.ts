// src/web/server-limits.test.ts — what a socket may send before and after it logs in, and how many may wait to log in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reply, textBlock } from "../../test/helpers/fake-model";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { openAuthed, rawSocket, testAccess, type TestSocket } from "../../test/helpers/web-client";
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TEXT_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENTS } from "../attachments/attachments";
import { assetsFromDir } from "./assets";
import type { DeviceStore } from "./devices";
import { WebHost } from "./host";
import type { LoginCodes } from "./login-codes";
import type { ServerMessage } from "./protocol";
import { MAX_AUTHED_MESSAGE_BYTES, MAX_MESSAGE_BYTES, MAX_PENDING_SOCKETS, POLICY_VIOLATION, parseClientMessage, startWebServer, type RunningWebServer } from "./server";

let dir: string;
let server: RunningWebServer | null = null;
let devices: DeviceStore;
let logins: LoginCodes;
let key: string;
const sockets: TestSocket[] = [];

beforeEach(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><title>app</title>");
  ({ devices, logins, key } = await testAccess(join(dir, "home")));
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.ws.close();
  await server?.stop();
  server = null;
  await removeDir(dir);
});

async function start() {
  const runtime = fakeRuntime([() => reply([textBlock("a picture")])]);
  server = await startWebServer({ host: new WebHost(runtime), assets: assetsFromDir(dir), devices, logins, port: 0 });
  return { runtime, base: `http://127.0.0.1:${server.port}` };
}

const track = (s: TestSocket) => (sockets.push(s), s);

describe("message size", () => {
  test("a socket that hasn't logged in and sends a big frame is closed with a policy violation, unparsed", async () => {
    const { base } = await start();
    const s = track(rawSocket(base));
    await s.opened;
    s.ws.send(JSON.stringify({ t: "auth", key: "x".repeat(MAX_MESSAGE_BYTES) }));
    expect(await s.closed).toBe(POLICY_VIOLATION);
  });

  test("a logged-in tab may send a prompt carrying a few MB of images", async () => {
    const { base, runtime } = await start();
    const s = track(await openAuthed(base, key));
    const png = new Uint8Array(3 * 1024 * 1024);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    s.send({ t: "rpc", id: 1, method: "prompt", params: { text: "look", attachments: [{ name: "a.png", mediaType: "image/png", data: Buffer.from(png).toString("base64") }] } });
    const result = (await s.next((m) => m.t === "rpc_result" && m.id === 1, 10_000)) as Extract<ServerMessage, { t: "rpc_result" }>;
    expect(result).toMatchObject({ ok: true, result: "end_turn" });
    expect(runtime.model.requests).toHaveLength(1);
  });

  test("the logged-in limit is what the attachment caps need in base64, plus the old limit for the rest", () => {
    const attachments = MAX_IMAGES * MAX_IMAGE_BYTES + MAX_TEXT_ATTACHMENTS * MAX_TEXT_ATTACHMENT_BYTES;
    expect(MAX_AUTHED_MESSAGE_BYTES).toBeGreaterThanOrEqual(Math.ceil((attachments * 4) / 3));
    expect(MAX_AUTHED_MESSAGE_BYTES).toBeLessThanOrEqual(Math.ceil((attachments * 4) / 3) + MAX_MESSAGE_BYTES);
    const over = Buffer.alloc(MAX_AUTHED_MESSAGE_BYTES + 1, 0x20);
    expect(parseClientMessage(over, { authed: true })).toBeNull();
  });
});

describe("sockets waiting to log in", () => {
  test(`at most ${MAX_PENDING_SOCKETS} at a time; one that logs in frees its place`, async () => {
    const { base } = await start();
    const waiting = Array.from({ length: MAX_PENDING_SOCKETS }, () => track(rawSocket(base)));
    await Promise.all(waiting.map((s) => s.opened));
    const extra = track(rawSocket(base));
    await expect(extra.opened).rejects.toThrow();
    // The first one logs in: it no longer counts.
    waiting[0]!.send({ t: "auth", key });
    await waiting[0]!.next((m) => m.t === "auth_ok");
    const next = track(rawSocket(base));
    await next.opened;
    // And one that closes frees its place too.
    waiting[1]!.ws.close();
    await waiting[1]!.closed;
    await new Promise((r) => setTimeout(r, 20));
    const another = track(rawSocket(base));
    await another.opened;
  });
});
