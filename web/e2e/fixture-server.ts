// web/e2e/fixture-server.ts — a real dashboard server over a throwaway TROPOS_HOME, for the Playwright run: two approved
// senders (one owner), two devices, phone access on, no provider (Setup unfinished), and a fake model whose first turn
// asks to run `Shell npm install`. Run by playwright.config.ts under Bun; never touches the real ~/.tropos.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordRun } from "../../src/agents/runs";
import { archiveSpecialist, createSpecialist, updateSpecialist } from "../../src/agents/store";
import { Ledger } from "../../src/learning/ledger";
import { FilePairing } from "../../src/gateway/pairing";
import { loadGatewayConfig, saveGatewayConfig } from "../../src/gateway/config";
import { assetsFromDir, SOURCE_DIST } from "../../src/web/assets";
import { createAdmin } from "../../src/web/admin";
import { remoteHandlers } from "../../src/web/admin/remote";
import { DeviceStore, devicesPath } from "../../src/web/devices";
import { WebHost } from "../../src/web/host";
import { loginCodesFor } from "../../src/web/login-codes";
import type { ChatHost } from "../../src/web/project-hosts";
import { startWebServer } from "../../src/web/server";
import { reply, textBlock, toolUseBlock } from "../../test/helpers/fake-model";
import { fakeRuntime } from "../../test/helpers/fake-runtime";

const port = Number(process.env.E2E_PORT);
const keyFile = process.env.E2E_KEY_FILE;
const codeFile = process.env.E2E_CODE_FILE;
if (!port || !keyFile || !codeFile) throw new Error("E2E_PORT, E2E_KEY_FILE and E2E_CODE_FILE are required");

const NAME = "mac.tail1234.ts.net";
const home = await mkdtemp(join(tmpdir(), "tropos-e2e-"));
process.env.TROPOS_HOME = home;
await mkdir(join(home, "gateway"), { recursive: true });

// Two approved senders, the first one the owner.
const pairing = new FilePairing({ path: join(home, "gateway", "pairing.json") });
for (const id of ["1001", "1002"]) {
  const c = await pairing.challenge("telegram", id);
  if (c.kind === "code") await pairing.approve("telegram", c.code);
}

// Devices: the e2e browser (local), a Chrome on the Mac, a Safari on an iPhone that came through Tailscale.
const devices = new DeviceStore({ path: devicesPath(home) });
await devices.create("Chrome on macOS", "local");
await devices.create("Safari on iPhone", "tailscale");
const e2e = await devices.create("Playwright", "local");
await mkdir(dirname(keyFile), { recursive: true });
await writeFile(keyFile, e2e.key);

const config = await loadGatewayConfig(home);
// A Telegram token (the fake fetch below answers getMe), so the Setup page's owner-link step has a bot to show.
await saveGatewayConfig(home, { ...config, telegram: { ...config.telegram, botToken: "123456:e2e-token" }, remoteAccess: { tailscale: true, httpsPort: 443, hostname: NAME } });

// The Agents page: a reviewer with runs, skills and a revision, a paused researcher, and an archived writer.
const ledger = new Ledger(home);
const owner = { ledger, actor: "agent" as const };
const contract = "## Purpose\nReview pull requests for bugs.\n## Not my job\nMerging.\n## Report\nFindings by severity.\n## Escalate when\nA change touches auth.";
await createSpecialist(home, { id: "reviewer", description: "Reviews pull requests for bugs and risky changes", prompt: contract, emoji: "🔍", tools: ["Read", "Grep", "Glob"] }, owner);
await updateSpecialist(home, "reviewer", { description: "Reviews pull requests for bugs, risky changes and missing tests" }, { ledger, actor: "review" });
await mkdir(join(home, "agents", "reviewer", "skills", "lint"), { recursive: true });
await writeFile(join(home, "agents", "reviewer", "MEMORY.md"), "Prefers small diffs. ".repeat(60));
await recordRun(home, { ts: new Date().toISOString(), agent: "reviewer", specialist: true, task: "review PR 12 in the web app", ok: true, result: "Two findings: a missing null check and an untested branch.", durationMs: 4200, costUsd: 0.03, cwd: home });
await recordRun(home, { ts: new Date(Date.now() - 3_600_000).toISOString(), agent: "reviewer", specialist: true, task: "look at the failing build", ok: false, result: "No build output was available to read.", durationMs: 900, cwd: home });
await createSpecialist(home, { id: "researcher", description: "Digs through docs and the web for answers", prompt: contract, emoji: "📚", model: "claude-sonnet-5-5" }, { ledger, actor: "user" });
await updateSpecialist(home, "researcher", { paused: true }, { ledger, actor: "user" });
await createSpecialist(home, { id: "scribe", description: "Drafts release notes", prompt: contract }, owner);
await archiveSpecialist(home, "scribe", { ledger, actor: "user" });

const logins = loginCodesFor(home);
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const runner = {
  exec: async (_cmd: string, args: string[]) =>
    args[0] === "status" ? ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${NAME}.` } })) : ok("{}"),
};
const ctx = {
  home,
  userHome: home,
  env: { HOME: home, TROPOS_HOME: home, PATH: "" } as NodeJS.ProcessEnv,
  version: "0.0.0-e2e",
  execPath: "/usr/local/bin/tcode",
  cwd: home,
  now: () => Date.now(),
  fetch: (async (input: unknown) => {
    if (String(input).endsWith("/getMe")) return Response.json({ ok: true, result: { id: 1, username: "tropos_e2e_bot", first_name: "Tropos" } });
    throw new Error("network is off in e2e");
  }) as unknown as typeof fetch,
  gateway: { runCronNow: async () => {}, reload: async () => {}, devicesChanged: async () => {} },
};
const admin = createAdmin(ctx, remoteHandlers(ctx, { runner }));

/** A fresh session per browser tab, so every test starts from an empty chat that asks to run `npm install`. */
function perTab(): ChatHost {
  const hosts = new Map<unknown, WebHost>();
  return {
    attach(send) {
      const runtime = fakeRuntime([
        () => reply([toolUseBlock("t1", "Shell", { command: "npm install" })], "tool_use"),
        () => reply([textBlock("Done.")]),
      ]);
      const host = new WebHost(runtime);
      hosts.set(send, host);
      const detach = host.attach(send);
      return () => {
        detach();
        hosts.delete(send);
        void host.shutdown();
      };
    },
    async handle(message, send) {
      await hosts.get(send)?.handle(message, send);
    },
    async shutdown() {
      await Promise.all([...hosts.values()].map((h) => h.shutdown()));
    },
  };
}

// A second, tiny server: GET /code issues a fresh 6-digit login code and writes it to E2E_CODE_FILE.
Bun.serve({
  hostname: "127.0.0.1",
  port: port + 1,
  async fetch() {
    const code = await logins.issueCode();
    await writeFile(codeFile, code);
    return new Response(code);
  },
});

// Last, so the main port answering means everything is ready (Playwright waits on it).
await startWebServer({ host: perTab(), admin, assets: assetsFromDir(SOURCE_DIST), devices, logins, port });
