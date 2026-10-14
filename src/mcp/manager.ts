// src/mcp/manager.ts
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerSetting } from "../config/settings";
import { errorText } from "../error-text";
import { isSecretEnvName } from "../tools/bash/bash";
import type { AnyTool } from "../tools/types";
import { VERSION } from "../version";
import { expandEnvVars } from "./names";
import { formatMs, mcpTool } from "./tool";

export interface McpServerStatus {
  name: string;
  state: "connected" | "failed" | "disabled";
  /** Tools this server contributes to the session. */
  tools: number;
  /** Why the server failed, or a note about tools that were skipped. */
  error?: string;
  type: "stdio" | "http" | "sse";
}

export interface McpManagerOptions {
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
  clientVersion?: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
/** Enough of a dying server's stderr to say why, without holding a chatty server's whole log. */
const STDERR_TAIL_CHARS = 2048;
/** A server that pages forever must not hang startup; real servers need one or two pages. */
const MAX_TOOL_PAGES = 100;

/** A positive integer from an env var, else the fallback. */
export function timeoutFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Keeps the last few KB of a child's stderr for error messages. */
class StderrTail {
  private text = "";

  push(chunk: unknown): void {
    this.text = (this.text + String(chunk)).slice(-STDERR_TAIL_CHARS);
  }

  get(): string {
    return this.text.trim();
  }
}

interface Connection {
  name: string;
  client: Client;
  defs: McpToolDef[];
}

function serverType(setting: McpServerSetting): McpServerStatus["type"] {
  return setting.type === "http" || setting.type === "sse" ? setting.type : "stdio";
}

function expandRecord(record: Record<string, string> | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) out[key] = expandEnvVars(String(value), env);
  return out;
}

/** Rejects with `message` once `signal` aborts; lets a hung connect lose a race instead of hanging startup. */
function abortRace<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Connects the configured MCP servers and exposes their tools. All servers connect in parallel once,
 * before the first request; after that the tool list never changes, so the prompt cache holds
 * (principle 2). A server that fails to start is a status entry with an error, never a throw
 * (principle 4).
 */
export class McpManager {
  private readonly connectTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly clientVersion: string;
  private readonly statuses = new Map<string, McpServerStatus>();
  private readonly clients = new Set<Client>();
  /** Closes of failed connections, run in the background so a slow child doesn't hold up startup. */
  private readonly closing = new Set<Promise<void>>();
  private toolList: AnyTool[] = [];
  private starting?: Promise<void>;
  private closed = false;

  constructor(
    private readonly servers: Record<string, McpServerSetting>,
    private readonly env: NodeJS.ProcessEnv,
    opts: McpManagerOptions = {},
  ) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? timeoutFromEnv(env.TROPOS_MCP_TIMEOUT, DEFAULT_CONNECT_TIMEOUT_MS);
    this.toolTimeoutMs = opts.toolTimeoutMs ?? timeoutFromEnv(env.TROPOS_MCP_TOOL_TIMEOUT, DEFAULT_TOOL_TIMEOUT_MS);
    this.clientVersion = opts.clientVersion ?? VERSION;
    for (const [name, setting] of Object.entries(servers)) {
      this.statuses.set(name, { name, state: "failed", tools: 0, error: "not started", type: serverType(setting) });
    }
  }

  /** Connects every enabled server in parallel. Safe to call twice; never throws. */
  start(): Promise<void> {
    this.starting ??= this.connectAll();
    return this.starting;
  }

  /** Every connected server's tools, sorted by name. */
  tools(): AnyTool[] {
    return [...this.toolList];
  }

  /** One entry per configured server, in settings order. */
  status(): McpServerStatus[] {
    return [...this.statuses.values()].map((s) => ({ ...s }));
  }

  /** Closes every client and stops stdio children. Idempotent; never throws. */
  async close(): Promise<void> {
    this.closed = true;
    const clients = [...this.clients];
    this.clients.clear();
    await Promise.all([...clients.map((c) => c.close().catch(() => {})), ...this.closing]);
  }

  private async connectAll(): Promise<void> {
    const names = Object.keys(this.servers);
    const connections = await Promise.all(names.map((name) => this.connect(name, this.servers[name]!)));
    // Merge in settings order, not connect order, so which duplicate wins doesn't depend on timing.
    const taken = new Map<string, string>();
    const tools: AnyTool[] = [];
    for (const conn of connections) {
      if (!conn) continue;
      const status = this.statuses.get(conn.name)!;
      const skipped: string[] = [];
      for (const def of conn.defs) {
        const tool = mcpTool(conn.name, def, conn.client, { timeoutMs: this.toolTimeoutMs });
        const owner = taken.get(tool.name);
        if (owner !== undefined) {
          skipped.push(`${def.name} (${tool.name} already comes from ${owner === conn.name ? "this server" : owner})`);
          continue;
        }
        taken.set(tool.name, conn.name);
        tools.push(tool);
        status.tools++;
      }
      if (skipped.length > 0) status.error = `Skipped tools with duplicate names: ${skipped.join(", ")}`;
    }
    this.toolList = tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Connects one server and lists its tools, recording the outcome in its status. */
  private async connect(name: string, setting: McpServerSetting): Promise<Connection | undefined> {
    const status = this.statuses.get(name)!;
    if (setting.disabled === true) {
      this.statuses.set(name, { name, state: "disabled", tools: 0, type: status.type });
      return undefined;
    }
    const stderr = new StderrTail();
    const client = new Client({ name: "tropos-code", version: this.clientVersion }, { capabilities: {} });
    // Transport errors also reject the pending request, which is where we report them.
    client.onerror = () => {};
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error(`Timed out after ${formatMs(this.connectTimeoutMs)} connecting to the server`)),
      this.connectTimeoutMs,
    );
    try {
      if (this.closed) throw new Error("MCP manager closed before the server started");
      const transport = this.transport(setting, stderr);
      this.clients.add(client);
      const opts = { signal: deadline.signal, timeout: this.connectTimeoutMs };
      const defs = await abortRace(
        (async () => {
          await client.connect(transport, opts);
          return this.listTools(client, opts);
        })(),
        deadline.signal,
      );
      client.onclose = () => {
        if (this.closed) return;
        const tail = stderr.get();
        status.state = "failed";
        status.error = `Server disconnected${tail ? `; stderr: ${tail}` : ""}`;
      };
      status.state = "connected";
      delete status.error;
      return { name, client, defs };
    } catch (error) {
      this.clients.delete(client);
      const done = client.close().catch(() => {});
      this.closing.add(done);
      void done.finally(() => this.closing.delete(done));
      const tail = stderr.get();
      status.state = "failed";
      status.error = `${errorText(error)}${tail ? `; stderr: ${tail}` : ""}`;
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async listTools(client: Client, opts: { signal: AbortSignal; timeout: number }): Promise<McpToolDef[]> {
    const defs: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, opts);
      defs.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return defs;
  }

  /** Builds the transport; `${VAR}` expands in args, env, url and headers. */
  private transport(setting: McpServerSetting, stderr: StderrTail): Transport {
    if (setting.type === "http" || setting.type === "sse") {
      const url = new URL(expandEnvVars(setting.url, this.env));
      const requestInit: RequestInit = { headers: expandRecord(setting.headers, this.env) };
      return setting.type === "http"
        ? new StreamableHTTPClientTransport(url, { requestInit })
        : new SSEClientTransport(url, { requestInit });
    }
    if (setting.type !== undefined && setting.type !== "stdio") {
      throw new Error(`Unsupported MCP server type "${String((setting as { type: unknown }).type)}"`);
    }
    const transport = new StdioClientTransport({
      command: setting.command,
      args: (setting.args ?? []).map((arg) => expandEnvVars(String(arg), this.env)),
      env: { ...this.baseEnv(), ...expandRecord(setting.env, this.env) },
      // Never the project by default: npx/uvx/bunx read the cwd's .npmrc and node_modules, which a cloned repo controls.
      cwd: setting.cwd ?? homedir(),
      // Piped, never inherited: a child writing to our stderr would tear through the Ink UI.
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => stderr.push(chunk));
    return transport;
  }

  /**
   * What every stdio child inherits: our environment minus anything that looks like a credential, the
   * same filter Bash uses. A server that needs a token names it in its `env`, e.g.
   * `"GITHUB_TOKEN": "${GITHUB_TOKEN}"`, so one server's config never leaks another's secrets.
   */
  private baseEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env)) {
      if (value !== undefined && !isSecretEnvName(key)) out[key] = value;
    }
    return out;
  }
}
