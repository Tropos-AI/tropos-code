// src/onboard/testing.ts — fakes for the onboarding tests: a provider/Telegram network, a service manager, a Docker runner.
import { fakeRunner } from "../doctor/testing";
import type { Runner } from "../doctor/types";
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

export function testDeps(home: string, over: Partial<OnboardDepsInput> = {}): OnboardDeps {
  const docker = fakeDocker({ daemon: false });
  return makeOnboardDeps({
    home,
    userHome: `${home}/..`,
    env: { PATH: "" },
    fetch: fakeNet().fetch,
    service: fakeService(),
    execPath: "/fake/bin/tcode",
    now: () => Date.UTC(2026, 9, 15, 12),
    doctor: { checks: [] },
    ...over,
    runner: { ...fakeRunner({ exec: docker.exec }), ...over.runner },
  });
}
