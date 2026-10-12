import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMockApi, type MockResponse } from "../helpers/mock-api";
import { makeTmpDir, removeDir } from "../helpers/tmp";

let dir: string;
let bin: string;

beforeAll(async () => {
  dir = await makeTmpDir();
  bin = join(dir, "tropos");
  await Bun.$`bun build.ts --outfile ${bin}`.quiet();
  await writeFile(join(dir, "hello.txt"), "hello world\n");
}, 120_000);
afterAll(() => removeDir(dir));

async function runBinary(args: string[], script: MockResponse[]) {
  const api = startMockApi(script);
  try {
    const proc = Bun.spawn([bin, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, TROPOS_HOME: join(dir, ".tropos-home"), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key" },
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

describe("compiled binary", () => {
  test("--version", async () => {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe" });
    expect(await new Response(proc.stdout).text()).toBe("0.1.0 (Tropos Code)\n");
  });

  test("print mode streams a text answer", async () => {
    const r = await runBinary(["-p", "hi"], [{ content: [{ type: "text", text: "Hi from the mock" }], stop_reason: "end_turn" }]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Hi from the mock\n");
  });

  test("the request follows the spec defaults", async () => {
    const r = await runBinary(["-p", "hi"], [{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
    const { headers, body } = r.requests[0]!;
    expect(headers["anthropic-beta"]).toContain("compact-2026-01-12");
    expect(headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      stream: true,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      fallbacks: "default",
    });
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "TodoWrite"]);
    expect(body.tools.every((t: { eager_input_streaming: boolean }) => t.eager_input_streaming)).toBe(true);
    expect(body.tool_choice).toBeUndefined();
  });

  test("a Read tool call round-trips through the binary", async () => {
    const r = await runBinary(
      ["-p", "read hello", "--output-format", "json"],
      [
        { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "hello.txt" } }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "It says hello world." }], stop_reason: "end_turn" },
      ],
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ type: "result", result: "It says hello world.", num_turns: 2, is_error: false });
    const toolResult = r.requests[1]!.body.messages[2].content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(toolResult.content).toContain("hello world");
  });

  test("print mode declines commands that are not allowed", async () => {
    const r = await runBinary(
      ["-p", "list files"],
      [
        { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "Could not run it." }], stop_reason: "end_turn" },
      ],
    );
    expect(r.code).toBe(0);
    expect(r.requests[1]!.body.messages[2].content[0]).toMatchObject({ is_error: true });
  });

  test("API errors exit 1 with a readable message", async () => {
    const r = await runBinary(["-p", "hi"], []);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("mock: script exhausted");
  });

  test("install.sh installs a versioned binary behind a symlink", async () => {
    await Bun.$`HOME=${dir} sh install.sh ${bin}`.quiet();
    const link = join(dir, ".local", "bin", "tropos");
    expect(await readlink(link)).toBe(join(dir, ".local", "share", "tropos", "versions", "0.1.0"));
    const proc = Bun.spawn([link, "--version"], { stdout: "pipe" });
    expect(await new Response(proc.stdout).text()).toContain("0.1.0");
  });
});
