// src/onboard/testing.ts — fakes for the onboarding tests: a provider/Telegram network, a service manager, a Docker runner.
import { fakeRunner } from "../doctor/testing";
import type { Runner } from "../doctor/types";
import type { MessagesView } from "../web/admin/api";
import type { ServiceManager, ServiceSpec, ServiceStatus } from "../service/types";
import { makeOnboardDeps, type OnboardDeps, type OnboardDepsInput } from "./engine";

export const GOOD_KEY = "sk-good-key-123456789";

export interface FakeNet {
  fetch: typeof fetch;
  calls: Array<{ url: string; auth?: string }>;
}

/** DeepSeek and Anthropic-style hosts accept GOOD_KEY; Telegram accepts the token "123:good"; everything else is unreachable. */
export function fakeNet(models: string[] = ["deepseek-chat", "deepseek-reasoner"]): FakeNet {
  const calls: FakeNet["calls"] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    calls.push({ url, auth });
    if (url.startsWith("https://api.telegram.org/bot")) {
      return url.includes("123:good")
        ? Response.json({ ok: true, result: { username: "tropos_bot", first_name: "Tropos" } })
        : Response.json({ ok: false, error_code: 401, description: `Unauthorized ${url}` }, { status: 401 });
    }
    if (url.startsWith("https://api.deepseek.com/models")) {
      return auth === `Bearer ${GOOD_KEY}` ? Response.json({ data: models.map((id) => ({ id })) }) : Response.json({ error: { message: `bad key ${auth}` } }, { status: 401 });
    }
    throw new Error(`unreachable in tests: ${url}`);
  };
  return { fetch: impl as typeof fetch, calls };
}

export interface FakeService extends ServiceManager {
  installed: ServiceSpec[];
  state: ServiceStatus;
}

export function fakeService(initial: Partial<ServiceStatus> = {}): FakeService {
  const svc: FakeService = {
    manager: "launchd",
    installed: [],
    state: { manager: "launchd", installed: false, running: false, ...initial },
    async install(spec) {
      svc.installed.push(spec);
      svc.state = { ...svc.state, installed: true, running: true };
      return { unitPath: "/fake/unit.plist" };
    },
    async uninstall() {
      return { removed: false };
    },
    async start() {},
    async stop() {},
    async restart() {},
    async status() {
      return svc.state;
    },
  } as FakeService;
  return svc;
}

/** Docker that works and has (or lacks) the image; `log` records the commands. */
export function fakeDocker(opts: { daemon?: boolean; image?: boolean } = {}): { exec: Runner["exec"]; log: string[][]; hasImage: boolean } {
  const state = { log: [] as string[][], hasImage: opts.image ?? true };
  const exec: Runner["exec"] = async (cmd, args) => {
    state.log.push([cmd, ...args]);
    if (opts.daemon === false) return { code: null, stdout: "", stderr: "", error: "docker: not found" };
    if (args[0] === "info") return { code: 0, stdout: "27.0\n", stderr: "" };
    if (args[0] === "image") return state.hasImage ? { code: 0, stdout: "sha256:x", stderr: "" } : { code: 1, stdout: "", stderr: "no such image" };
    if (args[0] === "pull") {
      state.hasImage = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  return Object.assign(state, { exec });
}

export interface FakeTailscale {
  exec: Runner["exec"];
  /** Local ports `tailscale serve` was asked to publish. */
  served: number[];
}

/** A `tailscale` CLI: not installed by default; `running` needs a `dnsName`. Any other program is "not found". */
export function fakeTailscale(opts: { installed?: boolean; running?: boolean; dnsName?: string } = {}): FakeTailscale {
  const served: number[] = [];
  const exec: Runner["exec"] = async (cmd, args) => {
    const installed = opts.installed ?? opts.running !== undefined;
    if (cmd !== "tailscale" || !installed) return { code: null, stdout: "", stderr: "", error: `${cmd}: not found` };
    if (args[0] === "status") {
      return opts.running
        ? { code: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: `${opts.dnsName}.` } }), stderr: "" }
        : { code: 1, stdout: "", stderr: "Logged out." };
    }
    if (args[0] === "serve" && args[1] === "status") return { code: 0, stdout: "{}", stderr: "" };
    if (args[0] === "serve") {
      served.push(Number(args.at(-1)?.split(":").pop()));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  return { exec, served };
}

export interface FakeMessages {
  platform: NodeJS.Platform;
  get(): Promise<MessagesView>;
  set(enabled: boolean): Promise<MessagesView>;
  openSettings(pane: "fda" | "automation"): Promise<void>;
  probe(): Promise<MessagesView>;
  /** Every call, in order: "get", "set:true", "open:fda", "probe". */
  calls: string[];
  view: MessagesView;
}

/** Texts without Messages, the helper or ~/Library: a view tests change, and a log of what was asked. Linux unless told otherwise. */
export function fakeMessages(opts: { platform?: NodeJS.Platform; view?: MessagesView } = {}): FakeMessages {
  const m: FakeMessages = {
    platform: opts.platform ?? "linux",
    view: opts.view ?? { available: (opts.platform ?? "linux") === "darwin", enabled: false },
    calls: [],
    async get() {
      m.calls.push("get");
      return m.view;
    },
    async set(enabled) {
      m.calls.push(`set:${enabled}`);
      m.view = enabled ? { available: true, enabled, status: m.view.status ?? { helper: { installed: true, version: 1, current: 1 }, fullDiskAccess: "no", automation: "unknown", signedIn: "unknown" } } : { available: true, enabled };
      return m.view;
    },
    async openSettings(pane) {
      m.calls.push(`open:${pane}`);
    },
    async probe() {
      m.calls.push("probe");
      return m.view;
    },
  };
  return m;
}

export function testDeps(home: string, over: Partial<OnboardDepsInput> = {}): OnboardDeps {
  // A fake Telegram server (telegramBaseUrl) is a real local HTTP server, so calls to it go through the real fetch.
  const net = fakeNet().fetch;
  const base = over.telegramBaseUrl;
  const baseFetch = base ? (((input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(base) ? fetch(input, init) : net(input, init))) as typeof fetch) : net;
  const docker = fakeDocker({ daemon: false });
  const tailscale = fakeTailscale();
  const exec: Runner["exec"] = (cmd, args, timeout) => (cmd === "tailscale" ? tailscale.exec(cmd, args, timeout) : docker.exec(cmd, args, timeout));
  return makeOnboardDeps({
    home,
    userHome: `${home}/..`,
    env: { PATH: "" },
    fetch: baseFetch,
    service: fakeService(),
    execPath: "/fake/bin/tcode",
    now: () => Date.UTC(2026, 9, 15, 12),
    doctor: { checks: [] },
    alive: () => false,
    confinement: async () => "sandbox-exec",
    which: () => null,
    messages: fakeMessages(),
    login: { oneTimeUrl: async () => "http://localhost:4317/#login=ONE-TIME-KEY", code: async () => "123456" },
    ...over,
    runner: { ...fakeRunner({ exec }), ...over.runner },
  });
}
