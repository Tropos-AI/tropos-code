// src/web/server.ts — the local HTTP + WebSocket server behind `tcode web`.
import { timingSafeEqual } from "node:crypto";
import { contentType, type AssetMap } from "./assets";
import type { WebHost } from "./host";
import { SESSION_COOKIE, WS_PATH, type ClientMessage, type ServerMessage } from "./protocol";

/** Answers host-level admin calls (src/web/admin). Throws an Error whose message is shown to the user. */
export interface AdminDispatcher {
  handle(method: string, params: unknown): Promise<unknown>;
}

export interface WebServerOptions {
  host: WebHost;
  /** Admin API; without it every admin call is answered "not available". */
  admin?: AdminDispatcher;
  assets: AssetMap;
  /** The launch secret: only a browser that opened the printed link gets the session cookie. */
  token: string;
  port: number;
  /** `tcode web --dev`: also accept the Vite dev server's origin (http://localhost:5173). */
  dev?: boolean;
}

export interface RunningWebServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
/** Largest message a tab may send: prompts are text, never files. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // motion and the icon component set inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

/** Shown to a browser without the session cookie: no scripts, nothing about the session. */
const LOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tropos Code</title>
<style>body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;background:#fafaf9;color:#1c1917;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:28rem;padding:2rem;background:#fff;border:1px solid #e7e5e4;border-radius:14px}</style></head>
<body><main><h1>Tropos Code</h1><p>Open this page from the link <code>tcode web</code> printed in your terminal. The link carries a secret key that keeps other pages and programs out.</p></main></body></html>`;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function respond(body: BodyInit | null, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  return new Response(body, { ...init, headers: { ...SECURITY_HEADERS, ...init.headers } });
}

/** Parses and shape-checks one message from a tab; anything else is dropped. */
export function parseClientMessage(raw: string | Buffer): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (m.t === "rpc" && Number.isInteger(m.id) && typeof m.method === "string") return m as unknown as ClientMessage;
  if (m.t === "admin" && Number.isInteger(m.id) && typeof m.method === "string" && m.method.length <= 64) return m as unknown as ClientMessage;
  if (m.t === "permission" && Number.isInteger(m.id) && m.answer && typeof m.answer === "object") {
    const kind = (m.answer as { kind?: unknown }).kind;
    if (kind === "allow" || kind === "deny" || kind === "allow_always") return m as unknown as ClientMessage;
  }
  return null;
}

interface SocketData {
  detach?: () => void;
  /** This tab's sender, the same function the host knows it by (so it can leave it out of broadcasts). */
  send?: (message: ServerMessage) => void;
}

export async function startWebServer(opts: WebServerOptions): Promise<RunningWebServer> {
  let port = opts.port;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(opts.dev ? DEV_ORIGINS : [])]);
  const authed = (req: Request) => {
    const cookie = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
    return cookie !== null && safeEqual(cookie, opts.token);
  };

  const serve = (p: number) =>
    Bun.serve<SocketData>({
      hostname: "127.0.0.1",
      port: p,
      fetch(req, server) {
        const url = new URL(req.url);
        // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends its own Host.
        const host = req.headers.get("host") ?? "";
        const devHost = opts.dev && (host === "localhost:5173" || host === "127.0.0.1:5173");
        if (!allowedHosts().has(host) && !devHost) return respond("Misdirected request", { status: 421 });

        const token = url.searchParams.get("token");
        if (token !== null && (url.pathname === "/" || url.pathname === "/auth")) {
          if (!safeEqual(token, opts.token)) return respond(LOCKED_PAGE, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
          return respond(null, {
            status: 302,
            headers: {
              Location: "/",
              "Set-Cookie": `${SESSION_COOKIE}=${opts.token}; HttpOnly; SameSite=Strict; Path=/`,
              "Cache-Control": "no-store",
            },
          });
        }

        if (url.pathname === WS_PATH) {
          // Cross-site WebSocket hijacking: browsers always send Origin on WebSocket handshakes.
          const origin = req.headers.get("origin");
          if (!origin || !allowedOrigins().has(origin) || !authed(req)) return respond("Forbidden", { status: 403 });
          if (server.upgrade(req, { data: {} })) return undefined;
          return respond("Expected a WebSocket", { status: 400 });
        }

        if (!authed(req)) {
          if (url.pathname === "/" || url.pathname === "/index.html") {
            return respond(LOCKED_PAGE, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
          }
          return respond("Unauthorized", { status: 401 });
        }
        if (req.method !== "GET" && req.method !== "HEAD") return respond("Method not allowed", { status: 405 });

        const asset = opts.assets.get(url.pathname);
        if (asset) {
          const immutable = url.pathname.startsWith("/assets/");
          return respond(Bun.file(asset), {
            headers: { "Content-Type": contentType(url.pathname), "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store" },
          });
        }
        // Client-side routes (#/skills) all load the app; a missing file with an extension is a real 404.
        const index = opts.assets.get("/index.html");
        if (index && !/\.[a-z0-9]+$/i.test(url.pathname)) {
          return respond(Bun.file(index), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
        }
        if (!index) {
          return respond("The web app isn't built. Run: bun run build:web", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        return respond("Not found", { status: 404 });
      },
      websocket: {
        maxPayloadLength: MAX_MESSAGE_BYTES,
        open(ws) {
          const send = (message: ServerMessage) => ws.send(JSON.stringify(message));
          ws.data.send = send;
          ws.data.detach = opts.host.attach(send);
        },
        message(ws, raw) {
          const message = parseClientMessage(raw as string | Buffer);
          if (!message || !ws.data.send) return;
          if (message.t === "admin") {
            const send = ws.data.send;
            const { id, method, params } = message;
            const admin = opts.admin;
            void (admin ? admin.handle(method, params) : Promise.reject(new Error("Not available here."))).then(
              (result) => send({ t: "admin_result", id, ok: true, result: result ?? null }),
              (error: unknown) => send({ t: "admin_result", id, ok: false, error: error instanceof Error ? error.message : "Failed." }),
            );
            return;
          }
          void opts.host.handle(message, ws.data.send);
        },
        close(ws) {
          ws.data.detach?.();
        },
      },
    });

  let server;
  try {
    server = serve(port);
  } catch (err) {
    // The default port is taken (another tcode web, say): any free port will do.
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    server = serve(0);
  }
  port = server.port!;
  return {
    port,
    url: `http://127.0.0.1:${port}/?token=${opts.token}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}
