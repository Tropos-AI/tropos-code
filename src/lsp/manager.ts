// src/lsp/manager.ts
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Settings } from "../config/settings";
import { gitRoot } from "../context/memory";
import { absolutePathEnv, safeWhich } from "../paths";
import { isSecretEnvName } from "../tools/bash/bash";
import { LspClient } from "./client";

export type Which = (bin: string) => string | null;

export interface LspTimings {
  /** Longest wait for publishDiagnostics after a change. */
  waitMs?: number;
  /** Quiet period after the last publish before its diagnostics count as settled. */
  quietMs?: number;
  /** Grace period for shutdown/exit in close() before the server is killed. */
  shutdownMs?: number;
  /** Longest wait for the initialize response. */
  initMs?: number;
}

interface ServerDef {
  name: string;
  argv: string[];
  initializationOptions?: unknown;
  env?: Record<string, string>;
}

interface Diagnostic {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  message?: string;
}

type Listener = (diagnostics: Diagnostic[], version: number | undefined) => void;

interface Server {
  client: LspClient;
  ready: Promise<boolean>;
  broken: boolean;
  /** Open documents and the last version sent for each. */
  docs: Map<string, number>;
  listeners: Map<string, Set<Listener>>;
  /** Called when the server dies, so nobody waits out the full timeout for a corpse. */
  onDeath: Set<() => void>;
}

/**
 * Built-in servers. Where a server can be told not to run project code, it is: rust-analyzer skips
 * build scripts, proc macros and cargo check; gopls never downloads the toolchain a go.mod asks for.
 * The rest (the project's own TypeScript, a configured Python environment) is why `lsp` is opt-in.
 */
const BUILTINS: { bin: string; args: string[]; extensions: string[]; initializationOptions?: unknown; env?: Record<string, string> }[] = [
  { bin: "typescript-language-server", args: ["--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] },
  { bin: "pyright-langserver", args: ["--stdio"], extensions: [".py"] },
  { bin: "gopls", args: [], extensions: [".go"], env: { GOTOOLCHAIN: "local" } },
  {
    bin: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    initializationOptions: { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false }, checkOnSave: false },
  },
];

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

const MAX_ERRORS = 20;
const SEVERITY_ERROR = 1;

/**
 * Language servers for post-write diagnostics. Each (server, root) pair starts lazily on the first
 * write it applies to and lives for the session. Anything that goes wrong (missing binary, crash,
 * bad initialize) marks that server broken for the session and yields null: diagnostics are a
 * bonus on a Write/Edit result, never a reason for it to fail.
 */
export class LspManager {
  private readonly servers = new Map<string, Server>();
  private readonly defs = new Map<string, ServerDef | null>();
  private readonly waitMs: number;
  private readonly quietMs: number;
  private readonly shutdownMs: number;
  private readonly initMs: number;
  private closed = false;

  constructor(
    private readonly setting: Settings["lsp"],
    private readonly cwd: string,
    private readonly which: Which = (bin) => safeWhich(bin, gitRoot(cwd) ?? cwd),
    timings: LspTimings = {},
  ) {
    this.waitMs = timings.waitMs ?? 3_000;
    this.quietMs = timings.quietMs ?? 300;
    this.shutdownMs = timings.shutdownMs ?? 2_000;
    this.initMs = timings.initMs ?? 15_000;
  }

  async diagnostics(path: string, content: string, signal: AbortSignal): Promise<string | null> {
    try {
      return await this.collect(path, content, signal);
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(servers.map((server) => this.shutdown(server)));
  }

  private async collect(path: string, content: string, signal: AbortSignal): Promise<string | null> {
    if (this.setting === false || this.closed || signal.aborted) return null;
    const file = resolve(this.cwd, path);
    const ext = extname(file).toLowerCase();
    const def = this.serverFor(ext);
    if (!def) return null;
    const root = gitRoot(dirname(file)) ?? this.cwd;
    const server = this.server(def, root);
    if (server.broken || !(await untilAborted(server.ready, signal, false)) || server.broken) return null;

    const uri = pathToFileURL(file).href;
    const diagnostics = await this.publishAfter(server, uri, signal, (version) => {
      if (version === 1) {
        server.client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: LANGUAGE_IDS[ext] ?? ext.slice(1), version, text: content },
        });
      } else {
        server.client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text: content }] });
      }
    });
    return diagnostics ? render(this.displayPath(file), diagnostics) : null;
  }

  /**
   * Sends the change and resolves with the diagnostics published for it: the last publish once
   * `quietMs` pass without another (servers often publish a syntactic pass, then a semantic one),
   * or the latest seen at the deadline. Null when nothing arrived, the call was aborted, or the
   * server died.
   */
  private publishAfter(server: Server, uri: string, signal: AbortSignal, send: (version: number) => void): Promise<Diagnostic[] | null> {
    const version = (server.docs.get(uri) ?? 0) + 1;
    server.docs.set(uri, version);
    return new Promise((done) => {
      let latest: Diagnostic[] | null = null;
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const listeners = server.listeners.get(uri) ?? new Set<Listener>();
      server.listeners.set(uri, listeners);
      const finish = () => {
        clearTimeout(deadline);
        clearTimeout(quiet);
        listeners.delete(listener);
        if (listeners.size === 0) server.listeners.delete(uri);
        server.onDeath.delete(onDeath);
        signal.removeEventListener("abort", onAbort);
        done(latest);
      };
      const listener: Listener = (diagnostics, published) => {
        // A publish tagged with an older version describes text that no longer exists.
        if (published !== undefined && published < version) return;
        latest = diagnostics;
        clearTimeout(quiet);
        quiet = setTimeout(finish, this.quietMs);
      };
      const onAbort = () => {
        latest = null;
        finish();
      };
      const onDeath = onAbort;
      const deadline = setTimeout(finish, this.waitMs);
      listeners.add(listener);
      server.onDeath.add(onDeath);
      signal.addEventListener("abort", onAbort, { once: true });
      send(version);
    });
  }

  /** Custom servers first, then the built-in for the extension when its binary is on PATH. */
  private serverFor(ext: string): ServerDef | null {
    if (!ext) return null;
    const cached = this.defs.get(ext);
    if (cached !== undefined) return cached;
    let def: ServerDef | null = null;
    if (typeof this.setting === "object") {
      for (const [name, custom] of Object.entries(this.setting)) {
        if (custom.disabled || custom.command.length === 0) continue;
        if (custom.extensions.some((e) => e.toLowerCase() === ext)) {
          // A bare program name is found the same safe way as the built-ins; not found, the server is skipped.
          const [bin, ...rest] = custom.command as [string, ...string[]];
          const found = bin.includes("/") ? bin : this.which(bin);
          if (found) def = { name, argv: [found, ...rest] };
          break;
        }
      }
    } else if (this.setting === true) {
      const builtin = BUILTINS.find((b) => b.extensions.includes(ext));
      const found = builtin ? this.which(builtin.bin) : null;
      if (builtin && found) {
        def = { name: builtin.bin, argv: [found, ...builtin.args], initializationOptions: builtin.initializationOptions, env: builtin.env };
      }
    }
    this.defs.set(ext, def);
    return def;
  }

  private server(def: ServerDef, root: string): Server {
    const key = `${def.name}\0${root}`;
    const existing = this.servers.get(key);
    if (existing) return existing;

    const client = new LspClient(def.argv, { cwd: root, env: { ...childEnv(), ...def.env } });
    const server: Server = {
      client,
      ready: Promise.resolve(false),
      broken: false,
      docs: new Map(),
      listeners: new Map(),
      onDeath: new Set(),
    };
    this.servers.set(key, server);

    client.onNotification("textDocument/publishDiagnostics", (params) => {
      const p = params as { uri?: string; version?: number; diagnostics?: Diagnostic[] } | null;
      if (!p?.uri) return;
      for (const listener of [...(server.listeners.get(p.uri) ?? [])]) {
        listener(Array.isArray(p.diagnostics) ? p.diagnostics : [], typeof p.version === "number" ? p.version : undefined);
      }
    });
    client.onRequest("workspace/configuration", (params) => {
      const items = (params as { items?: unknown[] } | null)?.items;
      return Array.isArray(items) ? items.map(() => null) : [];
    });
    void client.exited.then(() => {
      server.broken = true;
      for (const notify of [...server.onDeath]) notify();
    });

    const rootUri = pathToFileURL(root).href;
    server.ready = client
      .request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "tropos-code" },
          rootPath: root,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: basename(root) }],
          ...(def.initializationOptions === undefined ? {} : { initializationOptions: def.initializationOptions }),
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: false },
              publishDiagnostics: { relatedInformation: false, versionSupport: true },
            },
            workspace: { workspaceFolders: true, configuration: true },
          },
        },
        this.initMs,
      )
      .then(
        () => {
          client.notify("initialized", {});
          return true;
        },
        () => {
          server.broken = true;
          client.kill();
          return false;
        },
      );
    return server;
  }

  private async shutdown(server: Server): Promise<void> {
    if (!server.client.alive) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((r) => (timer = setTimeout(r, this.shutdownMs)));
    const polite = (async () => {
      try {
        await server.client.request("shutdown", null, this.shutdownMs);
      } catch {
        // Kill below.
      }
      server.client.notify("exit");
      await server.client.exited;
    })();
    await Promise.race([polite, grace]);
    clearTimeout(timer);
    if (server.client.alive) server.client.kill();
  }

  private displayPath(file: string): string {
    const rel = relative(this.cwd, file);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
  }
}

/** Formats up to MAX_ERRORS errors; warnings and hints are noise after an edit. Null when there are none. */
function render(file: string, diagnostics: Diagnostic[]): string | null {
  const errors = diagnostics.filter((d) => d.severity === SEVERITY_ERROR);
  if (errors.length === 0) return null;
  const lines = errors.slice(0, MAX_ERRORS).map((d) => {
    const line = (d.range?.start?.line ?? 0) + 1;
    const col = (d.range?.start?.character ?? 0) + 1;
    const message = String(d.message ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" ")
      .replaceAll("<", "&lt;");
    return `L${line}:${col} ${message}`;
  });
  if (errors.length > MAX_ERRORS) lines.push(`(${errors.length - MAX_ERRORS} more errors)`);
  return `<diagnostics file="${file.replaceAll('"', "&quot;")}">\n${lines.join("\n")}\n</diagnostics>`;
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise((done) => {
    const onAbort = () => done(fallback);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      done(value);
    });
  });
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!isSecretEnvName(name)) env[name] = value;
  // Children look programs up from the project directory: relative PATH entries would find the repo's.
  env.PATH = absolutePathEnv(env.PATH);
  return env;
}
