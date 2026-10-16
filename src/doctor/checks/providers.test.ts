import { afterEach, expect, test } from "bun:test";
import { fakeRunner, makeFixture, runOne, type Fixture } from "../testing";
import { providersCheck } from "./providers";

let fx: Fixture;
afterEach(() => fx?.close());

const withEnv = (env: NodeJS.ProcessEnv) => ({ env: { ...fx.env, ...env } });

test("no key and no local provider is an error that says what to do", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, providersCheck);
  expect(r.findings.at(-1)).toMatchObject({ id: "providers.keys", level: "error" });
  expect(r.findings.at(-1)!.detail).toContain("/providers");
});

test("a key in the environment counts, and the report never contains it", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, providersCheck, withEnv({ OPENAI_API_KEY: "sk-secret-123" }));
  expect(r.findings[0]!.level).toBe("ok");
  expect(r.findings[0]!.message).toContain("openai ($OPENAI_API_KEY)");
  expect(JSON.stringify(r)).not.toContain("sk-secret-123");
});

test("a key saved in credentials.json counts", async () => {
  fx = await makeFixture();
  await fx.write("credentials.json", JSON.stringify({ deepseek: { apiKey: "dk-1" } }));
  const r = await runOne(fx, providersCheck);
  expect(r.findings[0]!.message).toContain("deepseek (credentials.json)");
});

test("a keyless local endpoint counts when it answers; a keyless remote one never does", async () => {
  fx = await makeFixture();
  await fx.write("settings.json", JSON.stringify({ providers: { mine: { baseURL: "http://localhost:9000/v1" }, far: { baseURL: "https://example.com/v1" } } }));
  const up = (async (url: string) => (String(url).includes(":9000") ? new Response("{}") : Promise.reject(new Error("refused")))) as unknown as typeof fetch;
  const r = await runOne(fx, providersCheck, { runner: fakeRunner({ fetch: up }) });
  expect(r.findings[0]!.message).toContain("mine");
  expect(r.findings[0]!.message).not.toContain("far");
});

test("an unreadable credentials.json is reported", async () => {
  fx = await makeFixture();
  await fx.write("credentials.json", "{bad");
  const r = await runOne(fx, providersCheck, withEnv({ OPENAI_API_KEY: "k" }));
  expect(r.findings.some((f) => f.id === "providers.credentials" && f.level === "error")).toBe(true);
});

test("--deep lists models per provider and redacts keys from failure reasons", async () => {
  fx = await makeFixture();
  const listModels = async ({ id }: { id: string }) => {
    if (id === "openai") return ["gpt-a", "gpt-b"];
    throw new Error("401 Unauthorized for key sk-bad-999");
  };
  const r = await runOne(fx, providersCheck, { deep: true, ...withEnv({ OPENAI_API_KEY: "sk-good", XAI_API_KEY: "sk-bad-999" }), runner: fakeRunner({ listModels }) });
  expect(r.findings.find((f) => f.id === "providers.deep.openai")).toMatchObject({ level: "ok", message: expect.stringContaining("2 models") });
  const bad = r.findings.find((f) => f.id === "providers.deep.xai")!;
  expect(bad.level).toBe("warn");
  expect(bad.detail).toContain("401");
  expect(JSON.stringify(r)).not.toContain("sk-bad-999");
});

test("without --deep no listing call is made", async () => {
  fx = await makeFixture();
  let called = 0;
  await runOne(fx, providersCheck, { ...withEnv({ OPENAI_API_KEY: "k" }), runner: fakeRunner({ listModels: async () => { called++; return []; } }) });
  expect(called).toBe(0);
});
