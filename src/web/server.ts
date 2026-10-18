// src/web/server.ts — the dashboard's local HTTP + WebSocket server. The app shell is public; a socket gets nothing
// until its first message proves a device key (or logs in with a one-time key or a 6-digit code).
import type { ServerWebSocket } from "bun";
import { contentType, type AssetMap } from "./assets";
import { cleanDeviceName, type Device, type DeviceStore } from "./devices";
import { localDashboardUrl } from "./links";
import type { LoginCodes } from "./login-codes";
import { PortInUseError } from "./port";
import type { ChatHost } from "./project-hosts";
import { AUTH_CLOSE_CODE, WS_PATH, type ClientMessage, type ServerMessage } from "./protocol";
import type { AdminCaller } from "./admin/context";

/** Answers host-level admin calls (src/web/admin). Throws an Error whose message is shown to the user. */
export interface AdminDispatcher {
  handle(method: string, params: unknown, caller?: AdminCaller): Promise<unknown>;
}

export interface WebServerOptions {
  /** One session (`tcode web`) or one per project (the gateway's dashboard). */
  host: ChatHost;
  /** Admin API; without it every admin call is answered "not available". */
  admin?: AdminDispatcher;
  assets: AssetMap;
  /** Browsers that logged in; a socket authenticates against it. */
  devices: DeviceStore;
  /** One-time keys and 6-digit codes a browser without a key logs in with. */
  logins: LoginCodes;
  port: number;
  /** `tcode web --dev`: also accept the Vite dev server's origin (http://localhost:5173). */
  dev?: boolean;
  /** `host[:port]` of this Mac's tailnet name while phone access is on, else null; asked on every request. */
  remoteHost?: () => string | null;
}

export interface RunningWebServer {
  /** `http://localhost:<port>/`: one name everywhere, so a browser keeps one login. */
  url: string;
  port: number;
  /** Closes (with AUTH_CLOSE_CODE) every socket whose device is no longer in the store. */
  recheckDevices(): Promise<void>;
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

function respond(body: BodyInit | null, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  return new Response(body, { ...init, headers: { ...SECURITY_HEADERS, ...init.headers } });
}

/** Longest device key, one-time key or code a login message may carry (ours are 43 characters). */
const MAX_SECRET_LENGTH = 128;
const MAX_NAME_LENGTH = 200;

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
  // Rebuilt from the known fields: nothing else from a not-yet-trusted socket travels further.
  if (m.t === "auth" && typeof m.key === "string" && m.key.length <= MAX_SECRET_LENGTH) return { t: "auth", key: m.key };
  if (m.t === "login" && typeof m.value === "string" && m.value.length <= MAX_SECRET_LENGTH && typeof m.name === "string" && m.name.length <= MAX_NAME_LENGTH) {
    return { t: "login", value: m.value, name: m.name };
  }
  if (m.t === "rpc" && Number.isInteger(m.id) && typeof m.method === "string") return m as unknown as ClientMessage;
  if (m.t === "admin" && Number.isInteger(m.id) && typeof m.method === "string" && m.method.length <= 64) return m as unknown as ClientMessage;
  if (m.t === "permission" && Number.isInteger(m.id) && m.answer && typeof m.answer === "object") {
    const kind = (m.answer as { kind?: unknown }).kind;
    if (kind === "allow" || kind === "deny" || kind === "allow_always") return m as unknown as ClientMessage;
  }
  return null;
}

interface SocketData {
  /** "tailscale" when the socket's Origin is the tailnet name, else "local". */
  via: Device["via"];
  /** The device this socket logged in as; until then nothing but auth and login is handled. */
  deviceId?: string;
  /** Auth and login messages are handled one at a time, in order. */
  pending: Promise<void>;
  /** Closed by the browser, or logged out: nothing more is attached or answered. */
  closed: boolean;
  detach?: () => void;
  /** This tab's sender, the same function the host knows it by (so it can leave it out of broadcasts). */
  send?: (message: ServerMessage) => void;
}

type Socket = ServerWebSocket<SocketData>;
type Login = Extract<ClientMessage, { t: "auth" | "login" }>;

export async function startWebServer(opts: WebServerOptions): Promise<RunningWebServer> {
  let port = opts.port;
  const remote = (): string | null => opts.remoteHost?.() || null;
  const allowedHosts = () => {
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const name = remote();
    if (name) hosts.add(name);
    return hosts;
  };
  const allowedOrigins = () => {
    const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(opts.dev ? DEV_ORIGINS : [])]);
    const name = remote();
    if (name) origins.add(`https://${name}`);
    return origins;
  };
  /** Sockets that logged in, for recheckDevices. */
  const authed = new Set<Socket>();

  const attach = (ws: Socket, deviceId: string) => {
    ws.data.deviceId = deviceId;
    authed.add(ws);
    ws.data.detach = opts.host.attach(ws.data.send!);
  };

  /** The first message: a device key, or a one-time key / code that creates a device. Keys are never logged. */
  const authenticate = async (ws: Socket, message: Login): Promise<void> => {
    if (ws.data.closed || ws.data.deviceId !== undefined) return;
    const send = ws.data.send!;
    if (message.t === "auth") {
      const device = await opts.devices.verify(message.key, ws.data.via);
      if (ws.data.closed) return;
      if (!device) return send({ t: "auth_failed" });
      send({ t: "auth_ok", device: { id: device.id, name: device.name } });
      return attach(ws, device.id);
    }
    if (!(await opts.logins.redeem(message.value))) {
      const reason = (await opts.logins.locked()) ? "locked" : "invalid";
      if (!ws.data.closed) send({ t: "login_failed", reason });
      return;
    }
    const name = cleanDeviceName(message.name);
    const created = await opts.devices.create(name, ws.data.via);
    // Nobody received the key: the device could never be used.
    if (ws.data.closed) {
      await opts.devices.revoke(created.id);
      return;
    }
    send({ t: "login_ok", key: created.key, device: { id: created.id, name } });
    attach(ws, created.id);
  };

  const logOut = (ws: Socket) => {
    ws.data.closed = true;
    authed.delete(ws);
    ws.data.detach?.();
    ws.data.detach = undefined;
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

        if (url.pathname === WS_PATH) {
          // Cross-site WebSocket hijacking: browsers always send Origin on WebSocket handshakes.
          const origin = req.headers.get("origin");
          if (!origin || !allowedOrigins().has(origin)) return respond("Forbidden", { status: 403 });
          // Told by Origin, not Host: the tailnet proxy may or may not rewrite Host.
          const name = remote();
          const via: Device["via"] = name && origin === `https://${name}` ? "tailscale" : "local";
          if (server.upgrade(req, { data: { via, pending: Promise.resolve(), closed: false } })) return undefined;
          return respond("Expected a WebSocket", { status: 400 });
        }

        if (req.method !== "GET" && req.method !== "HEAD") return respond("Method not allowed", { status: 405 });

        // The shell and its assets hold no data and no secret: they are served to anyone who passed the Host check.
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
          // Not attached yet: the tab gets nothing until it logs in.
          ws.data.send = (message: ServerMessage) => ws.send(JSON.stringify(message));
        },
        message(ws, raw) {
          const message = parseClientMessage(raw as string | Buffer);
          if (!message || !ws.data.send || ws.data.closed) return;
          if (message.t === "auth" || message.t === "login") {
            ws.data.pending = ws.data.pending.then(() => authenticate(ws, message)).catch(() => {});
            return;
          }
          const deviceId = ws.data.deviceId;
          if (deviceId === undefined) return;
          if (message.t === "admin") {
            const send = ws.data.send;
            const { id, method, params } = message;
            const admin = opts.admin;
            void (admin ? admin.handle(method, params, { deviceId }) : Promise.reject(new Error("Not available here."))).then(
              (result) => send({ t: "admin_result", id, ok: true, result: result ?? null }),
              (error: unknown) => send({ t: "admin_result", id, ok: false, error: error instanceof Error ? error.message : "Failed." }),
            );
            return;
          }
          void opts.host.handle(message, ws.data.send);
        },
        close(ws) {
          logOut(ws);
        },
      },
    });

  let server;
  try {
    server = serve(port);
  } catch (err) {
    // The dashboard's address never moves by itself: the caller says who holds the port.
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new PortInUseError(port);
    throw err;
  }
  port = server.port!;
  return {
    port,
    url: localDashboardUrl(port),
    recheckDevices: async () => {
      if (authed.size === 0) return;
      const live = new Set((await opts.devices.list()).map((d) => d.id));
      for (const ws of [...authed]) {
        if (live.has(ws.data.deviceId!)) continue;
        logOut(ws);
        ws.close(AUTH_CLOSE_CODE, "Logged out");
      }
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
