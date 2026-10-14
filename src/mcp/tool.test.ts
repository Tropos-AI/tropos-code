// src/mcp/tool.test.ts
import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError, type Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import { makeToolContext } from "../../test/helpers/tool-context";
import { formatMs, mapCallResult, MAX_OUTPUT_CHARS, mcpTool, type McpCaller } from "./tool";

const def: McpToolDef = { name: "search", description: "Searches.", inputSchema: { type: "object", properties: { q: { type: "string" } } } };

function caller(impl: (...args: Parameters<McpCaller["callTool"]>) => Promise<unknown>): McpCaller {
  return { callTool: impl as McpCaller["callTool"] };
}

const ok = caller(async () => ({ content: [{ type: "text", text: "hi" }] }));

describe("mcpTool", () => {
  test("names, describes and types the tool", () => {
    const tool = mcpTool("srv", def, ok, { timeoutMs: 1000 });
    expect(tool.name).toBe("mcp__srv__search");
    expect(tool.description).toBe("Searches.");
    expect(tool.kind).toBe("exec");
    expect(tool.inputSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(tool.subject({ q: "x" }, "/")).toEqual({ paths: [] });
    expect(tool.schema.safeParse({ q: 1 }).success).toBe(true);
    expect(tool.schema.safeParse("nope").success).toBe(false);
  });

  test("read-only tools are read; missing schema type is forced to object", () => {
    const tool = mcpTool("srv", { name: "x", inputSchema: {} as McpToolDef["inputSchema"], annotations: { readOnlyHint: true } }, ok, {
      timeoutMs: 1000,
    });
    expect(tool.kind).toBe("net");
    expect(tool.inputSchema).toEqual({ type: "object" });
    expect(tool.description).toBe("MCP tool x from srv");
  });

  test("caps long descriptions at 2000 chars", () => {
    const tool = mcpTool("srv", { ...def, description: "d".repeat(5000) }, ok, { timeoutMs: 1000 });
    expect(tool.description.length).toBe(2000);
    expect(tool.description.endsWith("…")).toBe(true);
  });

  test("summarizes input as short JSON", () => {
    const tool = mcpTool("srv", def, ok, { timeoutMs: 1000 });
    expect(tool.summarize({ q: "x" })).toBe('{"q":"x"}');
    expect(tool.summarize({})).toBe("");
    expect(tool.summarize({ q: "y".repeat(200) }).length).toBe(80);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(tool.summarize(cyclic)).toBe("");
  });

  test("passes arguments, timeout and signal to callTool", async () => {
    let seen: unknown[] = [];
    const tool = mcpTool("srv", def, caller(async (...args) => ((seen = args), { content: [{ type: "text", text: "r" }] })), {
      timeoutMs: 1234,
    });
    const ctx = makeToolContext();
    expect(await tool.run({ q: "a" }, ctx)).toEqual({ content: "r" });
    expect(seen[0]).toEqual({ name: "search", arguments: { q: "a" } });
    expect(seen[2]).toEqual({ signal: ctx.signal, timeout: 1234 });
  });

  test("timeouts, aborts and thrown errors become error results", async () => {
    const timeout = mcpTool("srv", def, caller(async () => Promise.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out"))), {
      timeoutMs: 250,
    });
    expect(await timeout.run({}, makeToolContext())).toEqual({ content: "search on MCP server srv timed out after 250ms.", isError: true });

    const broken = mcpTool("srv", def, caller(async () => Promise.reject(new Error("Not connected"))), { timeoutMs: 1000 });
    expect(await broken.run({}, makeToolContext())).toEqual({ content: "search on MCP server srv failed: Not connected", isError: true });

    const controller = new AbortController();
    const aborting = mcpTool("srv", def, caller(async () => (controller.abort(), Promise.reject(new Error("aborted")))), { timeoutMs: 1000 });
    expect(await aborting.run({}, makeToolContext({ signal: controller.signal }))).toEqual({ content: "[interrupted by user]", isError: true });
    // Already aborted: the server is never called.
    expect(await broken.run({}, makeToolContext({ signal: controller.signal }))).toEqual({ content: "[interrupted by user]", isError: true });
  });
});

describe("mapCallResult", () => {
  test("joins text and passes isError through", () => {
    expect(mapCallResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], isError: true })).toEqual({
      content: "a\nb",
      isError: true,
    });
  });

  test("empty content falls back to structured content, then a placeholder", () => {
    expect(mapCallResult({ content: [], structuredContent: { n: 1 } })).toEqual({ content: '{"n":1}' });
    expect(mapCallResult({ content: [] })).toEqual({ content: "(no output)" });
    expect(mapCallResult({ toolResult: { legacy: true } })).toEqual({ content: '{"legacy":true}' });
  });

  test("images become image blocks in order", () => {
    const out = mapCallResult({
      content: [
        { type: "text", text: "before" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "after" },
      ],
    });
    expect(out.content).toEqual([
      { type: "text", text: "before" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "after" },
    ]);
    expect(out.summary).toBe("1 image");
  });

  test("unsupported and oversized media become notes; resources become text or uri", () => {
    const out = mapCallResult({
      content: [
        { type: "image", data: "AAAA", mimeType: "image/bmp" },
        { type: "image", data: "A".repeat(8 * 1024 * 1024), mimeType: "image/png" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///a", text: "body" } },
        { type: "resource", resource: { uri: "file:///b", blob: "AAAA" } },
        { type: "resource_link", uri: "file:///c", name: "c" },
        { type: "mystery" },
      ],
    });
    expect(out.content).toBe(
      [
        "[image of type image/bmp omitted: unsupported type]",
        "[image omitted: over 5 MB]",
        "[audio of type audio/wav omitted]",
        "body",
        "[resource: file:///b]",
        "[resource: file:///c]",
        "[unsupported mystery content omitted]",
      ].join("\n"),
    );
  });

  test("caps text at 50,000 chars with a note", () => {
    const out = mapCallResult({
      content: [
        { type: "text", text: "a".repeat(40_000) },
        { type: "text", text: "b".repeat(20_000) },
        { type: "text", text: "c".repeat(10) },
      ],
    });
    const text = out.content as string;
    expect(text).toContain("[Output truncated: showing 50,000 of 60,010 characters.]");
    expect(text.slice(0, text.indexOf("\n\n[Output")).replace(/\n/g, "").length).toBe(MAX_OUTPUT_CHARS);
    expect(text).not.toContain("cc");
  });
});

test("formatMs", () => {
  expect(formatMs(120_000)).toBe("120s");
  expect(formatMs(1500)).toBe("1500ms");
});
