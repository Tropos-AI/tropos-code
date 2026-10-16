import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { channelsHandlers } from "./channels";
import { adminWith, failure, makeKit, type Kit } from "./host-testkit";

const TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
let kit: Kit;
let urls: string[];
beforeEach(async () => {
  kit = await makeKit();
  urls = [];
});
afterEach(() => kit.close());

/** A Telegram that knows one token. */
const telegram = ((input: RequestInfo | URL) => {
  const url = String(input);
  urls.push(url);
  const good = url.includes(`/bot${TOKEN}/`);
  return Promise.resolve(
    new Response(JSON.stringify(good ? { ok: true, result: { id: 1, is_bot: true, first_name: "Tropos Bot", username: "tropos_bot" } } : { ok: false, error_code: 401, description: `Unauthorized (${url})` }), { status: good ? 200 : 401 }),
  );
}) as unknown as typeof fetch;

const admin = () => adminWith(kit, channelsHandlers(kit.ctx, { fetch: telegram }));
const gatewayJson = async () => JSON.parse(await readFile(join(kit.home, "gateway.json"), "utf8")) as Record<string, any>;

test("channels.get reports configured and source, never the token", async () => {
  expect(await admin().handle("channels.get", undefined)).toEqual({ telegram: { configured: false, source: null } });
  await writeFile(join(kit.home, "gateway.json"), JSON.stringify({ telegram: { botToken: TOKEN } }));
  const got = await admin().handle("channels.get", undefined);
  expect(got).toEqual({ telegram: { configured: true, source: "file" } });
  kit.ctx.env = { ...kit.ctx.env, TROPOS_TELEGRAM_BOT_TOKEN: "9:envtoken" };
  expect(await admin().handle("channels.get", undefined)).toEqual({ telegram: { configured: true, source: "env" } });
});

test("telegram.set verifies with getMe, saves privately, reloads the gateway and returns no token", async () => {
  const res = await admin().handle("channels.telegram.set", { token: ` ${TOKEN} ` });
  expect(res).toEqual({ configured: true, source: "file", bot: { username: "tropos_bot", name: "Tropos Bot" } });
  expect(JSON.stringify(res)).not.toContain(TOKEN);
  expect((await gatewayJson()).telegram.botToken).toBe(TOKEN);
  expect((await stat(join(kit.home, "gateway.json"))).mode & 0o077).toBe(0);
  expect(kit.reloads).toBe(1);
  expect(urls).toEqual([`https://api.telegram.org/bot${TOKEN}/getMe`]);
});

test("a rejected token is not saved and appears nowhere in the error", async () => {
  const bad = "111111:WRONGtokenWRONGtokenWRONGtokenWRONG123";
  const msg = await failure(admin(), "channels.telegram.set", { token: bad });
  expect(msg).toContain("Telegram did not accept");
  expect(msg).not.toContain(bad);
  expect(msg).not.toContain("WRONGtoken");
  await expect(readFile(join(kit.home, "gateway.json"), "utf8")).rejects.toThrow();
  expect(kit.reloads).toBe(0);
  expect(await failure(admin(), "channels.telegram.set", { token: "" })).toContain("token");
  expect(await failure(admin(), "channels.telegram.set", { token: "a b" })).toContain("spaces");
});

test("a network failure message does not carry the token either", async () => {
  const boom = (async (input: RequestInfo | URL) => {
    throw new Error(`connect failed for ${String(input)}`);
  }) as unknown as typeof fetch;
  const a = adminWith(kit, channelsHandlers(kit.ctx, { fetch: boom }));
  const msg = await failure(a, "channels.telegram.set", { token: TOKEN });
  expect(msg).not.toContain(TOKEN);
  expect(msg).not.toContain("ABCdef");
});

test("telegram.test checks the saved token without changing it; clear removes it", async () => {
  expect(await admin().handle("channels.telegram.test", undefined)).toEqual({ ok: false, error: "No bot token is set." });
  await admin().handle("channels.telegram.set", { token: TOKEN });
  const before = await readFile(join(kit.home, "gateway.json"), "utf8");
  expect(await admin().handle("channels.telegram.test", undefined)).toEqual({ ok: true, bot: { username: "tropos_bot", name: "Tropos Bot" } });
  expect(await readFile(join(kit.home, "gateway.json"), "utf8")).toBe(before);
  await writeFile(join(kit.home, "gateway.json"), JSON.stringify({ telegram: { botToken: "1:bad" } }));
  const bad = (await admin().handle("channels.telegram.test", undefined)) as any;
  expect(bad.ok).toBe(false);
  expect(bad.error).not.toContain("1:bad");
  await writeFile(join(kit.home, "gateway.json"), JSON.stringify({ telegram: { botToken: TOKEN } }));
  expect(await admin().handle("channels.telegram.clear", undefined)).toEqual({ configured: false, source: null });
  expect((await gatewayJson()).telegram.botToken).toBeUndefined();
});
