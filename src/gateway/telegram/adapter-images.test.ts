// src/gateway/telegram/adapter-images.test.ts — photos and image files from Telegram become image blocks in the turn.
import { afterEach, describe, expect, test } from "bun:test";
import { MAX_IMAGE_BYTES } from "../../attachments/attachments";
import { FakeTelegramServer } from "../../../test/helpers/telegram-fake-server";
import { FakePairing, FakeSessions, type FakeSession } from "../../../test/helpers/telegram-fakes";
import { UserFacingError } from "../errors";
import { TelegramApi, TelegramError } from "./api";
import { NON_TEXT_REPLY, TelegramAdapter } from "./adapter";

const CHAT = 42;
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function setup(opts: { approved?: boolean; mediaGroupWaitMs?: number } = {}) {
  const server = new FakeTelegramServer();
  const api = new TelegramApi({ token: server.token, baseUrl: server.baseUrl, sleep: async () => {} });
  const sessions = new FakeSessions();
  const pairing = new FakePairing();
  if (opts.approved !== false) pairing.approved.add(`telegram:${CHAT}`);
  const logs: string[] = [];
  const adapter = new TelegramAdapter({ api, sessions, pairing, minIntervalMs: 0, pollTimeoutSec: 1, mediaGroupWaitMs: opts.mediaGroupWaitMs ?? 20, log: (m) => logs.push(m) });
  cleanup.push(async () => {
    await adapter.stop();
    server.stop();
  });
  await adapter.start();
  const session = () => sessions.sessions.get(`telegram:${CHAT}`) as FakeSession | undefined;
  return { server, sessions, pairing, session, logs };
}

describe("Telegram images", () => {
  test("a photo becomes an image in the turn, its caption the text; the largest size is downloaded", async () => {
    const { server, session } = await setup();
    server.addFile("big", JPEG);
    server.pushPhoto(CHAT, CHAT, { fileId: "big", caption: "what is this?" });
    await server.waitFor(() => session()?.prompts.length === 1);
    expect(session()!.prompts).toEqual(["what is this?"]);
    expect(session()!.promptAttachments[0]).toEqual([{ name: "photo.jpg", mediaType: "image/jpeg", data: b64(JPEG) }]);
    expect(server.downloads).toEqual(["photos/big.bin"]);
    await server.waitFor(() => server.textsTo(CHAT).includes("echo: what is this?"));
  });

  test("a photo without a caption is sent with no text", async () => {
    const { server, session } = await setup();
    server.addFile("p1", JPEG);
    server.pushPhoto(CHAT, CHAT, { fileId: "p1" });
    await server.waitFor(() => session()?.prompts.length === 1);
    expect(session()!.prompts).toEqual([""]);
    expect(session()!.promptAttachments[0]).toHaveLength(1);
  });

  test("an image sent as a file (a document) is an image too, with its own name and type from its bytes", async () => {
    const { server, session } = await setup();
    server.addFile("doc", PNG);
    server.pushDocument(CHAT, CHAT, { fileId: "doc", fileName: "screenshot.png", mimeType: "image/png", caption: "fix this" });
    await server.waitFor(() => session()?.prompts.length === 1);
    expect(session()!.promptAttachments[0]).toEqual([{ name: "screenshot.png", mediaType: "image/png", data: b64(PNG) }]);
  });

  test("an album is one turn with every photo and the caption", async () => {
    const { server, session } = await setup({ mediaGroupWaitMs: 50 });
    server.addFile("a1", JPEG);
    server.addFile("a2", PNG);
    server.pushPhoto(CHAT, CHAT, { fileId: "a1", mediaGroupId: "g1", caption: "compare these" });
    server.pushPhoto(CHAT, CHAT, { fileId: "a2", mediaGroupId: "g1" });
    await server.waitFor(() => session()?.prompts.length === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(session()!.prompts).toEqual(["compare these"]);
    expect(session()!.promptAttachments[0]!.map((a) => a.mediaType)).toEqual(["image/jpeg", "image/png"]);
  });

  test("an image over 5 MB is not downloaded and the sender is told", async () => {
    const { server, session } = await setup();
    server.addFile("huge", JPEG, MAX_IMAGE_BYTES + 1);
    server.pushPhoto(CHAT, CHAT, { fileId: "huge", fileSize: MAX_IMAGE_BYTES + 1 });
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("over 5 MB")));
    expect(server.downloads).toEqual([]);
    expect(session()?.prompts ?? []).toEqual([]);
  });

  test("a document that says it is an image but isn't one is refused with a clear reply", async () => {
    const { server, session } = await setup();
    server.addFile("fake", new TextEncoder().encode("<svg onload=alert(1)>"));
    server.pushDocument(CHAT, CHAT, { fileId: "fake", fileName: "x.png", mimeType: "image/png" });
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("PNG, JPEG, GIF or WebP")));
    expect(session()?.prompts ?? []).toEqual([]);
  });

  test("a download that fails says so instead of going quiet", async () => {
    const { server, logs } = await setup();
    server.pushPhoto(CHAT, CHAT, { fileId: "missing" });
    await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("couldn't download")));
    expect(logs.join("\n")).not.toContain(server.token);
  });

  test("other files (a voice note, a PDF) keep a clear reply", async () => {
    const { server, session } = await setup();
    server.pushDocument(CHAT, CHAT, { fileId: "pdf", fileName: "a.pdf", mimeType: "application/pdf" });
    await server.waitFor(() => server.textsTo(CHAT).includes(NON_TEXT_REPLY));
    expect(session()?.prompts ?? []).toEqual([]);
  });

  test("a stranger's photo is ignored: nothing downloaded, no pairing code", async () => {
    const { server, pairing } = await setup({ approved: false });
    server.addFile("s", JPEG);
    server.pushPhoto(CHAT, CHAT, { fileId: "s" });
    server.pushMessage(CHAT, CHAT, "hi");
    await server.waitFor(() => server.sent.length >= 1);
    expect(server.downloads).toEqual([]);
    expect(pairing.challenges).toHaveLength(1);
  });

  test("a refused image (the session's own check) is explained to the sender", async () => {
    const { server, sessions } = await setup();
    server.addFile("p", JPEG);
    const opened = await sessions.open(`telegram:${CHAT}`);
    (opened as FakeSession).onPrompt = async () => {
      throw new UserFacingError("photo.jpg is too big (the limit is 5 MB).");
    };
    server.pushPhoto(CHAT, CHAT, { fileId: "p" });
    await server.waitFor(() => server.textsTo(CHAT).includes("photo.jpg is too big (the limit is 5 MB)."));
  });
});

describe("TelegramApi.downloadFile", () => {
  test("downloads up to a cap; past it, it stops with a 413 and the token is never in the error", async () => {
    const server = new FakeTelegramServer();
    cleanup.push(() => server.stop());
    const api = new TelegramApi({ token: server.token, baseUrl: server.baseUrl, sleep: async () => {} });
    server.addFile("f", JPEG);
    const file = await api.getFile("f");
    expect(file).toEqual({ path: "photos/f.bin", size: JPEG.length });
    expect(await api.downloadFile(file.path, 1024)).toEqual(JPEG);
    const err = await api.downloadFile(file.path, 4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).status).toBe(413);
    const missing = await api.downloadFile("photos/nope.bin", 1024).catch((e: unknown) => e);
    expect((missing as Error).message).not.toContain(server.token);
  });
});
