// test/e2e/providers.e2e.test.ts — the compiled binary against a local OpenAI-compatible server.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMockChatApi, type MockChatReply } from "../helpers/mock-chat-api";
import { makeTmpDir, removeDir } from "../helpers/tmp";

let dir: string;
let bin: string;
let home: string;

beforeAll(async () => {
  dir = await makeTmpDir();
  bin = join(dir, "tcode");
  home = join(dir, ".tropos-home");
  await Bun.$`bun build.ts --outfile ${bin}`.quiet();
  await writeFile(join(dir, "hello.txt"), "hello world\n");
}, 120_000);
afterAll(() => removeDir(dir));

async function run(model: string, script: MockChatReply[], settings: (url: string) => object, env: Record<string, string>) {
  const api = startMockChatApi(script);
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.json"), JSON.stringify(settings(api.url)));
    const proc = Bun.spawn([bin, "-p", "what does hello.txt say?", "--model", model, "--output-format", "json"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, TROPOS_HOME: home, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code, requests: api.requests };
  } finally {
    api.stop();
  }
}

const readThenAnswer: MockChatReply[] = [
  { reasoning: "I should read the file.", text: "Reading it.", toolCalls: [{ id: "call_1", name: "Read", arguments: { file_path: "hello.txt" } }] },
  { text: "It says hello world." },
];

test("a custom endpoint from user settings runs a full tool loop", async () => {
  const r = await run("mock/coder-1", readThenAnswer, (url) => ({ providers: { mock: { baseURL: url, name: "Mock" } } }), { MOCK_API_KEY: "mock-key" });
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ result: "It says hello world.", is_error: false, num_turns: 2, cost_usd: null });
  expect(r.requests).toHaveLength(2);
  expect(r.requests[0]!.headers.authorization).toBe("Bearer mock-key");
  const first = r.requests[0]!.body;
  expect(first.model).toBe("coder-1");
  expect(first.messages[0].role).toBe("system");
  expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toContain("Read");
  const second = r.requests[1]!.body.messages;
  expect(second.at(-2)).toMatchObject({ role: "assistant", content: "Reading it.", tool_calls: [{ id: "call_1", function: { name: "Read" } }] });
  expect(second.at(-2)).not.toHaveProperty("reasoning_content");
  expect(second.at(-1).role).toBe("tool");
  expect(second.at(-1).content).toContain("hello world");
});

test("DeepSeek gets its reasoning back during the tool loop, and the key comes from its own variable", async () => {
  const r = await run("deepseek/deepseek-flash", readThenAnswer, (url) => ({ providers: { deepseek: { baseURL: url } } }), { DEEPSEEK_API_KEY: "ds-key" });
  expect(r.code).toBe(0);
  expect(r.requests[0]!.headers.authorization).toBe("Bearer ds-key");
  expect(r.requests[0]!.body).toMatchObject({ model: "deepseek-flash", reasoning_effort: "high", stream_options: { include_usage: true } });
  expect(r.requests[1]!.body.messages.at(-2)).toMatchObject({ role: "assistant", reasoning_content: "I should read the file." });
});

test("a missing key fails fast with a pointer to /providers", async () => {
  const r = await run("deepseek/deepseek-flash", [], (url) => ({ providers: { deepseek: { baseURL: url } } }), {});
  expect(r.code).toBe(1);
  expect(r.requests).toHaveLength(0);
  expect(JSON.parse(r.stdout).error).toBe("No API key for DeepSeek. Run /providers to connect DeepSeek, or set DEEPSEEK_API_KEY.");
});
