import { afterEach, describe, expect, test } from "bun:test";
import { TelegramApi, TelegramError } from "./api";
import { FakeTelegramServer } from "../../../test/helpers/telegram-fake-server";

let server: FakeTelegramServer | undefined;
afterEach(() => server?.stop());

function setup() {
  server = new FakeTelegramServer();
  return { server, api: new TelegramApi({ token: server.token, baseUrl: server.baseUrl, sleep: async () => {} }) };
}

describe("TelegramApi", () => {
  test("sends and edits messages and parses updates, ignoring unknown fields", async () => {
    const { server, api } = setup();
    const msg = await api.sendMessage(7, "hi", { replyMarkup: { inline_keyboard: [[{ text: "A", callback_data: "x" }]] } });
    expect(msg.message_id).toBe(server.sent[0]!.messageId);
    expect(server.sent[0]!.replyMarkup?.inline_keyboard[0]![0]!.text).toBe("A");
    await api.editMessageText(7, msg.message_id, "edited");
    expect(server.sent[0]!.edits[0]!.text).toBe("edited");
    server.pushMessage(7, 7, "hello");
    const updates = await api.getUpdates(0, 1);
    expect(updates[0]!.message?.text).toBe("hello");
    expect(updates[0]!.message?.chat.type).toBe("private");
    await api.setMyCommands([{ command: "a", description: "b" }]);
    expect(server.commands).toHaveLength(1);
    await api.answerCallbackQuery("id1", "ok");
    expect(server.answered[0]).toEqual({ id: "id1", text: "ok" });
  });

  test("retries after a 429 with retry_after", async () => {
    const { server, api } = setup();
    server.rateLimitNextSend = 1;
    await api.sendMessage(1, "x");
    expect(server.sent).toHaveLength(1);
  });

  test("errors carry status and description and never the token", async () => {
    const { server } = setup();
    const bad = new TelegramApi({ token: server.token, baseUrl: server.baseUrl });
    const err = await bad.editMessageText(1, 999, "x").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.status).toBe(400);
    expect(err.description).toContain("not found");
    expect(err.message).not.toContain(server.token);
  });

  test("a network error whose message holds the URL is redacted", async () => {
    const token = "999:AAA-secret";
    const api = new TelegramApi({
      token,
      fetch: (async (url: string) => {
        throw new Error(`Unable to connect to ${url}`);
      }) as unknown as typeof fetch,
    });
    const err = await api.sendMessage(1, "x").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.message).not.toContain(token);
    expect(err.message).not.toContain("AAA-secret");
    expect(JSON.stringify(err.description)).not.toContain("secret");
  });

  test("a non-JSON failure becomes a TelegramError", async () => {
    const { server } = setup();
    server.failGetUpdates = 1;
    const api = new TelegramApi({ token: server.token, baseUrl: server.baseUrl });
    const err = await api.getUpdates(0, 0).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.status).toBe(500);
  });
});
