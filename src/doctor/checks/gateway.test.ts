import { afterEach, expect, test } from "bun:test";
import { byId, fakeRunner, makeFixture, runOne, type Fixture } from "../testing";
import { gatewayCheck } from "./gateway";

let fx: Fixture;
afterEach(() => fx?.close());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("no gateway.json is the defaults: valid, no token, no service", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, gatewayCheck);
  expect(byId(r, "gateway.config")!.level).toBe("ok");
  expect(byId(r, "gateway.telegram")!.level).toBe("info");
  expect(byId(r, "gateway.service")!.level).toBe("info");
});

test("an invalid gateway.json is an error naming the file", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", "{nope");
  const r = await runOne(fx, gatewayCheck);
  expect(byId(r, "gateway.config")).toMatchObject({ level: "error", message: expect.stringContaining("gateway.json") });
});

test("the token can come from the environment or the file, and is never printed", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", JSON.stringify({ telegram: { botToken: "123:file-token" } }));
  const fromFile = await runOne(fx, gatewayCheck);
  expect(byId(fromFile, "gateway.telegram")!.message).toContain("gateway.json");
  const fromEnv = await runOne(fx, gatewayCheck, { env: { ...fx.env, TROPOS_TELEGRAM_BOT_TOKEN: "456:env-token" } });
  expect(byId(fromEnv, "gateway.telegram")!.message).toContain("environment");
  expect(JSON.stringify([fromFile, fromEnv])).not.toMatch(/file-token|env-token/);
});

test("service status: installed but stopped warns, running is ok, a thrown error warns", async () => {
  fx = await makeFixture();
  const svc = (s: object) => fakeRunner({ serviceStatus: async () => s as never });
  expect(byId(await runOne(fx, gatewayCheck, { runner: svc({ manager: "launchd", installed: true, running: false }) }), "gateway.service")!.level).toBe("warn");
  expect(byId(await runOne(fx, gatewayCheck, { runner: svc({ manager: "systemd", installed: true, running: true, pid: 7 }) }), "gateway.service")!.message).toContain("pid 7");
  expect(byId(await runOne(fx, gatewayCheck, { runner: svc({ manager: "launchd", installed: false, running: false }) }), "gateway.service")!.level).toBe("info");
  const boom = fakeRunner({ serviceStatus: async () => { throw new Error("launchctl failed"); } });
  expect(byId(await runOne(fx, gatewayCheck, { runner: boom }), "gateway.service")).toMatchObject({ level: "warn", detail: "launchctl failed" });
});

test("--deep asks Telegram getMe and reports the bot's username", async () => {
  fx = await makeFixture();
  const urls: string[] = [];
  const fetch = (async (url: string) => (urls.push(String(url)), json({ ok: true, result: { username: "tropos_bot" } }))) as unknown as typeof globalThis.fetch;
  const r = await runOne(fx, gatewayCheck, { deep: true, env: { ...fx.env, TROPOS_TELEGRAM_BOT_TOKEN: "1:abc" }, runner: fakeRunner({ fetch }) });
  expect(urls).toEqual(["https://api.telegram.org/bot1:abc/getMe"]);
  expect(byId(r, "gateway.telegram.deep")!.message).toContain("@tropos_bot");
});

test("--deep: a rejected or unreachable token is reported without the token", async () => {
  fx = await makeFixture();
  const env = { ...fx.env, TROPOS_TELEGRAM_BOT_TOKEN: "1:secret" };
  const rejected = (async () => json({ ok: false, description: "Unauthorized" }, 401)) as unknown as typeof globalThis.fetch;
  const r1 = await runOne(fx, gatewayCheck, { deep: true, env, runner: fakeRunner({ fetch: rejected }) });
  expect(byId(r1, "gateway.telegram.deep")).toMatchObject({ level: "error", detail: "Unauthorized" });
  const down = (async (url: string) => { throw new Error(`connect failed for ${url}`); }) as unknown as typeof globalThis.fetch;
  const r2 = await runOne(fx, gatewayCheck, { deep: true, env, runner: fakeRunner({ fetch: down }) });
  expect(byId(r2, "gateway.telegram.deep")!.level).toBe("warn");
  expect(JSON.stringify(r2)).not.toContain("1:secret");
});

test("without --deep Telegram is not contacted", async () => {
  fx = await makeFixture();
  let calls = 0;
  const fetch = (async () => (calls++, json({}))) as unknown as typeof globalThis.fetch;
  await runOne(fx, gatewayCheck, { env: { ...fx.env, TROPOS_TELEGRAM_BOT_TOKEN: "1:abc" }, runner: fakeRunner({ fetch }) });
  expect(calls).toBe(0);
});
