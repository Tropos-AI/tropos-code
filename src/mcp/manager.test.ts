// src/mcp/manager.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServerSetting } from "../config/settings";
import { buildTestServer, PNG_1X1 } from "../../test/helpers/mcp-test-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { makeToolContext } from "../../test/helpers/tool-context";
import type { AnyTool } from "../tools/types";
import { McpManager, timeoutFromEnv } from "./manager";

const SERVER = join(import.meta.dir, "../../test/helpers/mcp-test-server.ts");

function stdio(...flags: string[]): McpServerSetting {
  return { command: process.execPath, args: [SERVER, ...flags] };
}

const managers: McpManager[] = [];
function manager(...args: ConstructorParameters<typeof McpManager>): McpManager {
  const m = new McpManager(...args);
  managers.push(m);
  return m;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

function find(m: McpManager, name: string): AnyTool {
  const tool = m.tools().find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe("McpManager over stdio", () => {
  test("connects, lists tools sorted and maps results", async () => {
    const m = manager({ test: stdio() }, process.env);
    await m.start();
    expect(m.status()).toEqual([{ name: "test", state: "connected", tools: 12, type: "stdio" }]);
    const names = m.tools().map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("mcp__test__echo");

    const echo = find(m, "mcp__test__echo");
    expect(echo.kind).toBe("net");
    expect(echo.description).toBe("Echoes its text back.");
    expect(echo.inputSchema?.type).toBe("object");
    expect(await echo.run({ text: "hello" }, makeToolContext())).toEqual({ content: "hello" });

    expect(find(m, "mcp__test__add").kind).toBe("exec");
    expect(await find(m, "mcp__test__add").run({ a: 2, b: 3 }, makeToolContext())).toEqual({ content: "5" });
    expect(await find(m, "mcp__test__fail").run({}, makeToolContext())).toEqual({ content: "it broke", isError: true });
    expect(await find(m, "mcp__test__image").run({}, makeToolContext())).toEqual({
      content: [
        { type: "text", text: "a pixel" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } },
      ],
      summary: "1 image",
    });
    expect(await find(m, "mcp__test__structured").run({}, makeToolContext())).toEqual({ content: '{"n":7}' });
    const mixed = await find(m, "mcp__test__mixed").run({}, makeToolContext());
    expect(mixed.content).toContain("resource text\n[resource: file:///blob.bin]\n[resource: file:///linked.txt]");
    const big = await find(m, "mcp__test__big").run({ chars: 60_000 }, makeToolContext());
    expect(big.content).toContain("[Output truncated: showing 50,000 of 60,000 characters.]");

    // Server-side validation failures come back as error results.
    const bad = await echo.run({ text: 5 }, makeToolContext());
    expect(bad.isError).toBe(true);
  });

  test("start is idempotent and the tool list is a copy", async () => {
    const m = manager({ test: stdio() }, process.env);
    const first = m.start();
    expect(m.start()).toBe(first);
    await first;
    m.tools().pop();
    expect(m.tools()).toHaveLength(12);
  });

  test("expands ${VAR} in args and env, strips secrets, honours cwd", async () => {
    const dir = await makeTmpDir();
    try {
      const env = { ...process.env, GREETING: "hi", MY_API_KEY: "secret", PLAIN_VAR: "plain" };
      const m = manager(
        {
          s: {
            command: process.execPath,
            args: [SERVER, "${GREETING}", "${NOPE:-fallback}"],
            env: { SERVER_TOKEN: "${MY_API_KEY}" },
            cwd: dir,
          },
        },
        env,
      );
      await m.start();
      const run = (name: string, input: Record<string, unknown> = {}) => find(m, `mcp__s__${name}`).run(input, makeToolContext());
      expect(await run("argv")).toEqual({ content: '["hi","fallback"]' });
      expect(await run("env", { name: "SERVER_TOKEN" })).toEqual({ content: "secret" });
      expect(await run("env", { name: "MY_API_KEY" })).toEqual({ content: "<unset>" });
      expect(await run("env", { name: "PLAIN_VAR" })).toEqual({ content: "plain" });
      expect(await run("cwd")).toEqual({ content: dir });
    } finally {
      await removeDir(dir);
    }
  });

  test("a command that doesn't exist is a failed status, not a throw", async () => {
    const m = manager({ bad: { command: "/nonexistent/tropos-mcp-server" }, good: stdio() }, process.env);
    await m.start();
    const [bad, good] = m.status();
    expect(bad).toMatchObject({ name: "bad", state: "failed", tools: 0, type: "stdio" });
    expect(bad!.error).toBeTruthy();
    expect(good).toMatchObject({ name: "good", state: "connected" });
    expect(m.tools().every((t) => t.name.startsWith("mcp__good__"))).toBe(true);
  });

  test("a server that exits reports its stderr", async () => {
    const m = manager({ crash: stdio("--crash") }, process.env);
    await m.start();
    const [status] = m.status();
    expect(status!.state).toBe("failed");
    expect(status!.error).toContain("boom: missing config");
  });

  test("a server that never answers times out", async () => {
    const m = manager({ hang: stdio("--hang") }, { ...process.env, TROPOS_MCP_TIMEOUT: "300" });
    const started = Date.now();
    await m.start();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(m.status()[0]).toMatchObject({ state: "failed", error: "Timed out after 300ms connecting to the server" });
  });

  test("disabled servers are not started", async () => {
    const m = manager({ off: { ...stdio(), disabled: true }, web: { type: "http", url: "http://127.0.0.1:1/", disabled: true } }, process.env);
    await m.start();
    expect(m.status()).toEqual([
      { name: "off", state: "disabled", tools: 0, type: "stdio" },
      { name: "web", state: "disabled", tools: 0, type: "http" },
    ]);
    expect(m.tools()).toEqual([]);
  });

  test("status before start says so", () => {
    const m = manager({ test: stdio() }, process.env);
    expect(m.status()).toEqual([{ name: "test", state: "failed", tools: 0, error: "not started", type: "stdio" }]);
  });

  test("tool calls time out", async () => {
    const m = manager({ test: stdio() }, process.env, { toolTimeoutMs: 200 });
    await m.start();
    const result = await find(m, "mcp__test__slow").run({ ms: 5000 }, makeToolContext());
    expect(result).toEqual({ content: "slow on MCP server test timed out after 200ms.", isError: true });
  });

  test("tool calls stop on abort", async () => {
    const m = manager({ test: stdio() }, process.env);
    await m.start();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const result = await find(m, "mcp__test__slow").run({ ms: 10_000 }, makeToolContext({ signal: controller.signal }));
    expect(result).toEqual({ content: "[interrupted by user]", isError: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("duplicate names after sanitizing keep the first and note the rest", async () => {
    const m = manager({ d: stdio("--dupes"), "d2": stdio() }, process.env);
    await m.start();
    const [d] = m.status();
    expect(d!.state).toBe("connected");
    expect(d!.tools).toBe(13);
    expect(d!.error).toBe("Skipped tools with duplicate names: a_b (mcp__d__a_b already comes from this server)");
    expect(await find(m, "mcp__d__a_b").run({}, makeToolContext())).toEqual({ content: "dot" });
  });

  test("duplicates across servers name the owner", async () => {
    // Both names cut down to the same 64 chars.
    const long = "s".repeat(70);
    const m = manager({ [`${long}a`]: stdio(), [`${long}b`]: stdio() }, process.env);
    await m.start();
    const [, second] = m.status();
    expect(second!.tools).toBe(0);
    expect(second!.error).toContain(`already comes from ${long}a`);
  });

  test("a server that dies later is marked failed and its calls fail", async () => {
    const m = manager({ test: stdio() }, process.env);
    await m.start();
    expect(await find(m, "mcp__test__exit").run({}, makeToolContext())).toEqual({ content: "bye" });
    for (let i = 0; i < 100 && m.status()[0]!.state === "connected"; i++) await Bun.sleep(20);
    expect(m.status()[0]).toMatchObject({ state: "failed", error: expect.stringContaining("Server disconnected") });
    const after = await find(m, "mcp__test__echo").run({ text: "x" }, makeToolContext());
    expect(after.isError).toBe(true);
  });

  test("close stops servers; calls afterwards are error results", async () => {
    const m = manager({ test: stdio() }, process.env);
    await m.start();
    const echo = find(m, "mcp__test__echo");
    await m.close();
    await m.close();
    expect(m.status()[0]!.state).toBe("connected");
    const result = await echo.run({ text: "x" }, makeToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("echo on MCP server test failed");
  });

  test("start after close connects nothing", async () => {
    const m = manager({ test: stdio() }, process.env);
    await m.close();
    await m.start();
    expect(m.status()[0]).toMatchObject({ state: "failed", error: "MCP manager closed before the server started" });
  });

  test("close during start stops the pending server", async () => {
    const m = manager({ hang: stdio("--hang") }, process.env, { connectTimeoutMs: 10_000 });
    const starting = m.start();
    await Bun.sleep(100);
    const started = Date.now();
    await m.close();
    await starting;
    expect(Date.now() - started).toBeLessThan(8000);
    expect(m.status()[0]!.state).toBe("failed");
  });
});

describe("McpManager over HTTP", () => {
  test("connects to a streamable HTTP server with expanded url and headers", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push(req.headers.get("authorization") ?? "");
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await buildTestServer().connect(transport);
        return transport.handleRequest(req);
      },
    });
    try {
      const m = manager(
        { web: { type: "http", url: "http://127.0.0.1:${MCP_PORT}/mcp", headers: { Authorization: "Bearer ${MCP_TOKEN}" } } },
        { MCP_PORT: String(server.port), MCP_TOKEN: "tok" },
      );
      await m.start();
      expect(m.status()[0]).toMatchObject({ name: "web", state: "connected", type: "http" });
      expect(await find(m, "mcp__web__add").run({ a: 1, b: 1 }, makeToolContext())).toEqual({ content: "2" });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((h) => h === "Bearer tok")).toBe(true);
    } finally {
      await Promise.all(managers.splice(0).map((m) => m.close()));
      await server.stop(true);
    }
  });

  test("bad urls, refused connections and unknown types fail cleanly", async () => {
    const m = manager(
      {
        nourl: { type: "http", url: "not a url" },
        refused: { type: "sse", url: "http://127.0.0.1:1/sse" },
        weird: { type: "websocket", url: "ws://x" } as unknown as McpServerSetting,
      },
      {},
      { connectTimeoutMs: 2000 },
    );
    await m.start();
    const [nourl, refused, weird] = m.status();
    expect(nourl).toMatchObject({ state: "failed", type: "http" });
    expect(refused).toMatchObject({ state: "failed", type: "sse" });
    expect(weird).toMatchObject({ state: "failed", type: "stdio", error: 'Unsupported MCP server type "websocket"' });
  });
});

test("timeoutFromEnv takes positive integers only", () => {
  expect(timeoutFromEnv("500", 1)).toBe(500);
  expect(timeoutFromEnv(undefined, 1)).toBe(1);
  expect(timeoutFromEnv("", 1)).toBe(1);
  expect(timeoutFromEnv("0", 1)).toBe(1);
  expect(timeoutFromEnv("-5", 1)).toBe(1);
  expect(timeoutFromEnv("1.5", 1)).toBe(1);
  expect(timeoutFromEnv("abc", 1)).toBe(1);
});
