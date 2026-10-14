// test/helpers/mcp-test-server.ts
// A tiny MCP server for the src/mcp tests. Run as a stdio server with `bun test/helpers/mcp-test-server.ts`;
// flags pick a failure mode: --hang (never answers initialize), --crash (writes stderr, exits 1),
// --dupes (two tool names that sanitize to the same thing). The HTTP test imports buildTestServer.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** A 1x1 transparent PNG. */
export const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** `exit` adds a tool that ends the process, so only the stdio entry point turns it on. */
export function buildTestServer(opts: { dupes?: boolean; exit?: boolean } = {}): McpServer {
  const server = new McpServer({ name: "tropos-test", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "Echoes its text back.", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool("add", { description: "Adds two numbers.", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }));
  server.registerTool("fail", { description: "Always fails." }, async () => ({
    content: [{ type: "text", text: "it broke" }],
    isError: true,
  }));
  server.registerTool("image", {}, async () => ({
    content: [
      { type: "text", text: "a pixel" },
      { type: "image", data: PNG_1X1, mimeType: "image/png" },
    ],
  }));
  server.registerTool("slow", { inputSchema: { ms: z.number() } }, async ({ ms }, extra) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      extra.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { content: [{ type: "text", text: "done" }] };
  });
  server.registerTool("mixed", {}, async () => ({
    content: [
      { type: "text", text: "first" },
      { type: "resource", resource: { uri: "file:///notes.txt", text: "resource text" } },
      { type: "resource", resource: { uri: "file:///blob.bin", blob: "AAAA" } },
      { type: "resource_link", uri: "file:///linked.txt", name: "linked" },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      { type: "image", data: "AAAA", mimeType: "image/bmp" },
    ],
  }));
  server.registerTool("big", { inputSchema: { chars: z.number() } }, async ({ chars }) => ({
    content: [{ type: "text", text: "x".repeat(chars) }],
  }));
  server.registerTool("env", { inputSchema: { name: z.string() } }, async ({ name }) => ({
    content: [{ type: "text", text: process.env[name] ?? "<unset>" }],
  }));
  server.registerTool("cwd", {}, async () => ({ content: [{ type: "text", text: process.cwd() }] }));
  server.registerTool("argv", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }] }));
  server.registerTool("structured", { outputSchema: { n: z.number() } }, async () => ({
    content: [],
    structuredContent: { n: 7 },
  }));
  if (opts.exit) {
    server.registerTool("exit", { description: "Answers, then the process exits." }, async () => {
      setTimeout(() => process.exit(0), 20);
      return { content: [{ type: "text", text: "bye" }] };
    });
  }
  if (opts.dupes) {
    server.registerTool("a.b", {}, async () => ({ content: [{ type: "text", text: "dot" }] }));
    server.registerTool("a_b", {}, async () => ({ content: [{ type: "text", text: "underscore" }] }));
  }
  return server;
}

if (import.meta.main) {
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--crash")) {
    process.stderr.write("boom: missing config\n");
    process.exit(1);
  }
  if (flags.has("--hang")) {
    // Read stdin but never answer, like a server stuck before its handshake.
    process.stdin.resume();
    setInterval(() => {}, 1 << 30);
  } else {
    process.stderr.write("test server ready\n");
    await buildTestServer({ dupes: flags.has("--dupes"), exit: true }).connect(new StdioServerTransport());
  }
}
