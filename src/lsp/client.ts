// src/lsp/client.ts
import { spawn, type ChildProcess } from "node:child_process";
import { errorText } from "../error-text";

export type NotificationHandler = (params: unknown) => void;
/** Answers a request the server sends to us; the return value becomes the response's result. */
export type RequestHandler = (params: unknown) => unknown;

export interface LspClientOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Message {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

const HEADER_END = Buffer.from("\r\n\r\n");

/**
 * A minimal JSON-RPC 2.0 client over a child's stdio with LSP's Content-Length framing. It knows
 * nothing about LSP semantics; the manager builds those on top. Every failure (spawn error, crash,
 * timeout) surfaces as a rejected request or the `exited` promise, never as a thrown exception.
 */
export class LspClient {
  /** Resolves once the process is gone, however it went. */
  readonly exited: Promise<void>;
  private readonly child: ChildProcess;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Map<string, NotificationHandler>();
  private readonly requests = new Map<string, RequestHandler>();
  private dead = false;
  private markExited!: () => void;

  constructor(argv: string[], options: LspClientOptions) {
    this.exited = new Promise((resolve) => (this.markExited = resolve));
    const [bin, ...args] = argv as [string, ...string[]];
    // Detached so kill() reaches the whole group: tsserver and friends fork helpers of their own.
    this.child = spawn(bin, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
    // Language servers log freely on stderr; drain it so a chatty server never blocks on a full pipe.
    this.child.stderr!.on("data", () => {});
    this.child.stdin!.on("error", () => {});
    this.child.once("error", (err) => this.die(`could not start ${bin}: ${errorText(err)}`));
    this.child.once("exit", (code, sig) => this.die(`server exited (${sig ?? `code ${code}`})`));
    // A forgotten close() must not keep the CLI alive.
    this.child.unref();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      (stream as unknown as { unref?: () => void } | null)?.unref?.();
    }
  }

  get alive(): boolean {
    return !this.dead;
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notifications.set(method, handler);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requests.set(method, handler);
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(`${method}: server is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { method, resolve, reject };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  kill(): void {
    try {
      if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
    } catch {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  private send(message: object): void {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    try {
      this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
    } catch {
      // The exit handler reports the death.
    }
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      const start = headerEnd + HEADER_END.length;
      if (!match) {
        // Not a frame we understand: skip the header and resync on the next one.
        this.buffer = this.buffer.subarray(start);
        continue;
      }
      const end = start + Number(match[1]);
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(start, end).toString("utf8");
      this.buffer = this.buffer.subarray(end);
      let message: Message;
      try {
        message = JSON.parse(body) as Message;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Message): void {
    const hasId = message.id !== undefined && message.id !== null;
    if (message.method !== undefined) {
      if (hasId) {
        // Servers block on some of their own requests (workspace/configuration, registerCapability), so always answer.
        let result: unknown = null;
        try {
          result = this.requests.get(message.method)?.(message.params) ?? null;
        } catch {
          result = null;
        }
        this.send({ jsonrpc: "2.0", id: message.id, result });
        return;
      }
      try {
        this.notifications.get(message.method)?.(message.params);
      } catch {
        // A handler bug must not break the read loop.
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message ?? "error"}`));
    else entry.resolve(message.result ?? null);
  }

  private die(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${entry.method}: ${reason}`));
    }
    this.pending.clear();
    this.markExited();
  }
}
