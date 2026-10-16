// src/web/admin/extensions.ts — `mcp.*` and `plugins.setEnabled`: MCP servers and plugins in the user's settings.
// Env and header values are write-only: they are never listed, and never appear in an error shown to the owner.
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConfigStoreError, readUserSettingsRaw, setAt, unsetAt, updateUserSettings } from "../../config/store";
import { mcpServerSchema, type McpServerSetting } from "../../config/settings";
import { errorText } from "../../error-text";
import { loadPlugins } from "../../extensions/plugins";
import { expandEnvVars } from "../../mcp/names";
import type { McpServerStatus } from "../../mcp/manager";
import { isSecretEnvName } from "../../tools/bash/bash";
import { VERSION } from "../../version";
import type { McpServerInput, McpServerView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { scrub } from "./util";

export interface ExtensionsDeps {
  /** The live MCP manager of the running session or gateway, when there is one. */
  manager(): { status(): McpServerStatus[] } | undefined;
  /** Starts the server, lists its tool names, and always cleans up. Rejects with the reason. */
  probe(setting: McpServerSetting, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<string[]>;
  timeoutMs: number;
}

export const MCP_TEST_TIMEOUT_MS = 15_000;
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const STDERR_TAIL = 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What an MCP server needs to run, checked: only these fields are kept. */
function settingFrom(input: unknown): McpServerSetting {
  if (!isObject(input)) throw new AdminError("Describe the server with a type and a command or URL.");
  const { type, command, url } = input;
  const strings = (v: unknown, what: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new AdminError(`${what} must be a list of text.`);
    return v as string[];
  };
  const record = (v: unknown, what: string): Record<string, string> | undefined => {
    if (v === undefined) return undefined;
    if (!isObject(v) || Object.values(v).some((x) => typeof x !== "string")) throw new AdminError(`${what} must be names with text values.`);
    return v as Record<string, string>;
  };
  let candidate: unknown;
  if (type === "http" || type === "sse") {
    if (typeof url !== "string" || !url.trim()) throw new AdminError("A URL is needed for an http or sse server.");
    candidate = { type, url: url.trim(), ...(input.headers === undefined ? {} : { headers: record(input.headers, "Headers") }) };
  } else if (type === "stdio" || type === undefined) {
    if (typeof command !== "string" || !command.trim()) throw new AdminError("A command is needed for a stdio server.");
    const args = strings(input.args, "Arguments");
    candidate = { type: "stdio", command: command.trim(), ...(args ? { args } : {}), ...(input.env === undefined ? {} : { env: record(input.env, "Environment") }) };
  } else {
    throw new AdminError('The type is "stdio", "http" or "sse".');
  }
  const parsed = mcpServerSchema.safeParse(candidate);
  if (!parsed.success) throw new AdminError(`That server isn't valid: ${parsed.error.issues[0]?.path.join(".") || "value"}: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
  return parsed.data;
}

/** The command line or URL, without env/header values and without credentials or query strings in a URL. */
function targetOf(s: McpServerSetting): string {
  if ("url" in s) {
    try {
      const u = new URL(s.url);
      return `${u.origin}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      return "(invalid URL)";
    }
  }
  return [s.command, ...(s.args ?? [])].join(" ");
}

const typeOf = (s: McpServerSetting): McpServerView["type"] => ("url" in s ? s.type : "stdio");

/** The secret values of a setting, to remove from any message. */
const secretsOf = (s: McpServerSetting): string[] => Object.values("url" in s ? (s.headers ?? {}) : (s.env ?? {})).filter((v) => v.length >= 4);

const expandAll = (rec: Record<string, string> | undefined, env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(rec ?? {}).map(([k, v]) => [k, expandEnvVars(v, env)]));

/** Connects with the official SDK exactly as the session manager does, lists the tools, closes. */
async function probeServer(setting: McpServerSetting, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<string[]> {
  let stderrText = "";
  let transport: Transport;
  if ("url" in setting) {
    const url = new URL(expandEnvVars(setting.url, env));
    const requestInit: RequestInit = { headers: expandAll(setting.headers, env) };
    transport = setting.type === "http" ? new StreamableHTTPClientTransport(url, { requestInit }) : new SSEClientTransport(url, { requestInit });
  } else {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined && !isSecretEnvName(k)) base[k] = v;
    const stdio = new StdioClientTransport({
      command: setting.command,
      args: (setting.args ?? []).map((a) => expandEnvVars(a, env)),
      env: { ...base, ...expandAll(setting.env, env) },
      // Never a project directory: npx/uvx read the cwd's config, which a cloned repo controls.
      cwd: setting.cwd ?? cwd,
      stderr: "pipe",
    });
    stdio.stderr?.on("data", (chunk) => void (stderrText = (stderrText + String(chunk)).slice(-STDERR_TAIL)));
    transport = stdio;
  }
  const client = new Client({ name: "tropos-code", version: VERSION }, { capabilities: {} });
  client.onerror = () => {};
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  try {
    const work = (async () => {
      const opts = { signal: deadline.signal, timeout: timeoutMs };
      await client.connect(transport, opts);
      const names: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const r = await client.listTools(cursor === undefined ? undefined : { cursor }, opts);
        names.push(...r.tools.map((t) => t.name));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      return names;
    })();
    // A hung connect loses this race; the finally below then kills the child.
    return await new Promise<string[]>((resolve, reject) => {
      deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true });
      work.then(resolve, reject);
    });
  } catch (err) {
    const tail = stderrText.trim();
    throw new Error(`${errorText(err)}${tail ? `; stderr: ${tail}` : ""}`);
  } finally {
    clearTimeout(timer);
    // Closing the client closes the transport, which stops a stdio child.
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export function extensionsHandlers(ctx: AdminContext, deps: Partial<ExtensionsDeps> = {}): AdminHandlers {
  const manager = deps.manager ?? (() => undefined);
  const probe = deps.probe ?? probeServer;
  const timeoutMs = deps.timeoutMs ?? MCP_TEST_TIMEOUT_MS;

  async function configured(): Promise<Record<string, McpServerSetting>> {
    const raw = await readUserSettingsRaw(ctx.home).catch((err) => {
      throw new AdminError(err instanceof Error ? err.message : "settings.json can't be read.");
    });
    const servers = isObject(raw.mcpServers) ? raw.mcpServers : {};
    const out: Record<string, McpServerSetting> = {};
    for (const [name, value] of Object.entries(servers)) {
      const parsed = mcpServerSchema.safeParse(value);
      if (parsed.success) out[name] = parsed.data;
    }
    return out;
  }

  async function list(): Promise<McpServerView[]> {
    const live = new Map((manager()?.status() ?? []).map((s) => [s.name, s]));
    return Object.entries(await configured()).map(([name, s]): McpServerView => {
      const status = live.get(name);
      const base = { name, type: typeOf(s), target: targetOf(s) };
      if (s.disabled === true) return { ...base, state: "disabled" };
      if (!status) return { ...base, state: "unknown" };
      return { ...base, state: status.state, tools: status.tools, ...(status.error ? { error: scrub(status.error, secretsOf(s)) } : {}) };
    });
  }

  const write = async (change: (draft: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
    try {
      await updateUserSettings(ctx.home, change);
    } catch (err) {
      if (err instanceof ConfigStoreError) throw new AdminError(err.message);
      throw err;
    }
    await ctx.gateway?.reload().catch(() => undefined);
  };

  const checkName = (name: unknown): string => {
    if (typeof name !== "string" || !NAME.test(name)) throw new AdminError("Server names are 1-40 letters, digits, _ and -.");
    return name;
  };

  return {
    "mcp.list": () => list(),

    async "mcp.add"({ name, server }) {
      const id = checkName(name);
      const setting = settingFrom(server satisfies McpServerInput);
      if (id in (await configured())) throw new AdminError(`A server named ${id} already exists. Remove it first to replace it.`);
      await write((draft) => setAt(draft, ["mcpServers", id], setting));
      return list();
    },

    async "mcp.remove"({ name }) {
      const id = checkName(name);
      if (!(id in (await configured()))) throw new AdminError(`There is no server named ${id}.`);
      await write((draft) => unsetAt(draft, ["mcpServers", id]));
      return list();
    },

    async "mcp.test"({ server }) {
      const setting = settingFrom(server);
      try {
        const tools = await probe(setting, ctx.env, ctx.userHome || homedir(), timeoutMs);
        return { ok: true, tools: [...tools].sort() };
      } catch (err) {
        // Values from env/headers (and anything shaped like a key) never reach the browser.
        return { ok: false, tools: [], error: scrub(errorText(err), secretsOf(setting)).slice(0, 1000) };
      }
    },

    async "plugins.setEnabled"({ name, enabled }) {
      if (typeof name !== "string" || !name || typeof enabled !== "boolean") throw new AdminError("Give a plugin name and true or false.");
      const raw = await readUserSettingsRaw(ctx.home).catch(() => ({}) as Record<string, unknown>);
      const off = Array.isArray(raw.disabledPlugins) ? raw.disabledPlugins.filter((x): x is string => typeof x === "string") : [];
      const { plugins } = await loadPlugins(ctx.home, off);
      if (!plugins.some((p) => p.name === name)) throw new AdminError(`There is no plugin named ${name.slice(0, 60)}.`);
      const next = enabled ? off.filter((n) => n !== name) : [...new Set([...off, name])];
      await write((draft) => (next.length === 0 ? unsetAt(draft, ["disabledPlugins"]) : setAt(draft, ["disabledPlugins"], next)));
      return { name, enabled };
    },
  };
}
