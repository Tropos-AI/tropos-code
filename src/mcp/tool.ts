// src/mcp/tool.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError, type ContentBlock, type Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorText } from "../error-text";
import type { AnyTool, ToolOutput, ToolResultContent } from "../tools/types";
import { mcpToolName } from "./names";

const MAX_DESCRIPTION = 2000;
const MAX_SUMMARY = 80;
export const MAX_OUTPUT_CHARS = 50_000;
/** Same ceiling as Read: a bigger base64 image would only fail the API request. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
type ResultBlock = Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam;

/** The part of the SDK client a tool needs; tests may hand in a stub. */
export type McpCaller = Pick<Client, "callTool">;

export interface McpToolOptions {
  /** Per-call timeout in ms. */
  timeoutMs: number;
}

const schema = z.record(z.string(), z.unknown());

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The server's schema, sent raw; the API insists on an object at the top level, so force that. */
function inputSchemaOf(def: McpToolDef): Anthropic.Beta.BetaTool.InputSchema {
  const raw = (def.inputSchema ?? {}) as Record<string, unknown>;
  return { ...raw, type: "object" } as Anthropic.Beta.BetaTool.InputSchema;
}

/** "120s" for whole seconds, else "250ms". */
export function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

/** One MCP content block as text, or as an image block when the API can take it. */
function mapBlock(block: ContentBlock): string | Anthropic.Beta.BetaImageBlockParam {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      if (!IMAGE_TYPES.has(block.mimeType)) return `[image of type ${block.mimeType} omitted: unsupported type]`;
      if (base64Bytes(block.data) > MAX_IMAGE_BYTES) return `[image omitted: over 5 MB]`;
      return { type: "image", source: { type: "base64", media_type: block.mimeType as ImageMediaType, data: block.data } };
    case "audio":
      return `[audio of type ${block.mimeType} omitted]`;
    case "resource": {
      const r = block.resource;
      return "text" in r && typeof r.text === "string" ? r.text : `[resource: ${r.uri}]`;
    }
    case "resource_link":
      return `[resource: ${block.uri}]`;
    default:
      return `[unsupported ${String((block as { type?: unknown }).type)} content omitted]`;
  }
}

/**
 * Turns a tools/call result into tool output. Text is joined with newlines and capped at
 * MAX_OUTPUT_CHARS overall (images don't count); output stays a plain string unless the server
 * returned images, so the common case reads like any built-in tool's result.
 */
export function mapCallResult(result: Record<string, unknown>): ToolOutput {
  const isError = result.isError === true;
  let blocks: ContentBlock[];
  if (Array.isArray(result.content)) blocks = result.content as ContentBlock[];
  else if ("toolResult" in result) blocks = [{ type: "text", text: JSON.stringify(result.toolResult) }];
  else blocks = [];
  if (blocks.length === 0 && result.structuredContent !== undefined) {
    blocks = [{ type: "text", text: JSON.stringify(result.structuredContent) }];
  }

  const out: ResultBlock[] = [];
  let pending: string[] = [];
  let used = 0;
  let total = 0;
  const flush = (): void => {
    if (pending.length > 0) out.push({ type: "text", text: pending.join("\n") });
    pending = [];
  };
  for (const block of blocks) {
    const mapped = mapBlock(block);
    if (typeof mapped !== "string") {
      flush();
      out.push(mapped);
      continue;
    }
    total += mapped.length;
    const room = MAX_OUTPUT_CHARS - used;
    if (room <= 0) continue;
    const kept = mapped.length > room ? mapped.slice(0, room) : mapped;
    used += kept.length;
    pending.push(kept);
  }
  if (total > used) {
    pending.push(`\n[Output truncated: showing ${used.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters.]`);
  }
  flush();

  const images = out.filter((b) => b.type === "image").length;
  let content: ToolResultContent;
  if (images === 0) content = out.map((b) => (b as Anthropic.Beta.BetaTextBlockParam).text).join("\n") || "(no output)";
  else content = out;
  const summary = images > 0 ? `${images} image${images === 1 ? "" : "s"}` : undefined;
  return { content, ...(isError ? { isError } : {}), ...(summary ? { summary } : {}) };
}

/**
 * Wraps one server tool as a Tropos tool. The model sees the server's own JSON Schema; zod only checks
 * that the input is an object, since the server validates the rest. Calls are `exec` unless the server
 * marks the tool read-only, so they ask unless a rule allows them. Every failure (timeout, abort, a
 * dead server) comes back as an error result, never a throw (principle 4).
 */
export function mcpTool(server: string, def: McpToolDef, caller: McpCaller, opts: McpToolOptions): AnyTool {
  const name = mcpToolName(server, def.name);
  const description = def.description?.trim() ? cap(def.description.trim(), MAX_DESCRIPTION) : `MCP tool ${def.name} from ${server}`;
  return {
    name,
    // Annotations are the server's own claim (the MCP spec calls them untrusted hints): a read-only
    // tool still asks unless a rule allows it, but may run in parallel and in plan mode.
    kind: def.annotations?.readOnlyHint === true ? "net" : "exec",
    description,
    schema,
    inputSchema: inputSchemaOf(def),
    summarize(input) {
      let text: string;
      try {
        text = JSON.stringify(input) ?? "";
      } catch {
        text = "";
      }
      return cap(text === "{}" ? "" : text, MAX_SUMMARY);
    },
    subject: () => ({ paths: [] }),
    async run(input, ctx) {
      if (ctx.signal.aborted) return { content: "[interrupted by user]", isError: true };
      try {
        const result = await caller.callTool({ name: def.name, arguments: input as Record<string, unknown> }, undefined, {
          signal: ctx.signal,
          timeout: opts.timeoutMs,
        });
        return mapCallResult(result as Record<string, unknown>);
      } catch (error) {
        if (ctx.signal.aborted) return { content: "[interrupted by user]", isError: true };
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
          return { content: `${def.name} on MCP server ${server} timed out after ${formatMs(opts.timeoutMs)}.`, isError: true };
        }
        return { content: `${def.name} on MCP server ${server} failed: ${errorText(error)}`, isError: true };
      }
    },
  };
}
