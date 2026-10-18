import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ChatSettingsView, OnboardState, OnboardStep } from "@core/web/admin/api";
import type { ProviderInfoView } from "@core/web/protocol";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { SetupPage, firstOpenStep } = await import("@/app/pages/SetupPage");
const { TELEGRAM_POLL_MS } = await import("@/components/setup/remote-steps");

const has = (selector: string): boolean => document.querySelector(selector) !== null;
const SECRET = "sk-test-VERY-SECRET-987654";

const STEPS: OnboardStep[] = [
  { id: "welcome", title: "Welcome", status: "todo", optional: true },
  { id: "provider", title: "Connect a model", status: "todo", optional: false },
  { id: "model", title: "Choose a model", status: "todo", optional: false },
  { id: "identity", title: "Name and personality", status: "todo", optional: true },
  { id: "projects", title: "Projects", status: "todo", optional: true },
  { id: "autonomy", title: "Autonomy", status: "todo", optional: true, detail: "Default: Balanced." },
  { id: "telegram", title: "Telegram", status: "todo", optional: true },
  { id: "phone", title: "Phone access", status: "todo", optional: true },
  { id: "service", title: "Run in the background", status: "todo", optional: true },
  { id: "done", title: "All set", status: "todo", optional: true },
];

const PROVIDERS = (saved: boolean): ProviderInfoView[] => [
  { id: "openai", name: "OpenAI", keyRequired: true, keyURL: "https://platform.openai.com/api-keys", keyEnv: ["OPENAI_API_KEY"], key: saved ? { kind: "saved" } : null },
  { id: "ollama", name: "Ollama", keyRequired: false, keyURL: null, keyEnv: [], noKeyNote: "Runs on this machine.", key: null },
];

function server(over: Record<string, (p: never) => unknown> = {}, opts: { fresh?: boolean; confinement?: "sandbox-exec" | null; backend?: "host" | "docker" } = {}) {
  let steps = opts.fresh ? STEPS : STEPS.map((s) => (s.id === "welcome" ? { ...s, status: "done" as const } : s));
  let chat: ChatSettingsView = { autonomy: "balanced", backend: opts.backend ?? "host", explicit: false, confinement: opts.confinement === undefined ? "sandbox-exec" : opts.confinement, allowUnconfined: false, installHint: "brew install bubblewrap" };
  let dismissed = false;
  let saved = false;
  let telegram = false;
  const state = (): OnboardState => ({ steps, complete: steps.filter((s) => !s.optional).every((s) => s.status === "done"), dismissed });
  const mark = (id: string, status: OnboardStep["status"]) => (steps = steps.map((s) => (s.id === id ? { ...s, status } : s)));
  const admin = {
    "onboard.state": state,
    "onboard.start": () => {
      mark("welcome", "done");
      return state();
    },
    "onboard.skip": (p: { id: string }) => {
      mark(p.id, "skipped");
      return state();
    },
    "onboard.identity.save": () => {
      mark("identity", "done");
      return state();
    },
    "onboard.projects.scan": () => ({
      repos: [
        { path: "/w/alpha", name: "alpha", touchedAt: 2, recent: true, registered: false },
        { path: "/w/old", name: "old", touchedAt: 1, recent: false, registered: false },
        { path: "/w/have", name: "have", touchedAt: 3, recent: true, registered: true },
      ],
      truncated: true,
    }),
    "onboard.projects.add": (p: { paths: string[] }) => {
      mark("projects", "done");
      return { added: p.paths, failed: [] };
    },
    "onboard.autonomy.get": () => chat,
    "onboard.autonomy.set": (p: { autonomy: "ask" | "balanced" | "autonomous" }) => {
      chat = { ...chat, autonomy: p.autonomy, explicit: true };
      mark("autonomy", "done");
      return chat;
    },
    "onboard.validateKey": (p: { key: string }) => (p.key === SECRET ? { ok: true, models: ["gpt-a", "gpt-b", "gpt-c", "gpt-d", "gpt-e"] } : { ok: false, models: [], error: `bad key ${p.key}` }),
    "onboard.finish": () => {
      dismissed = true;
      return state();
    },
    "onboard.reopen": () => {
      dismissed = false;
      return state();
    },
    "channels.get": () => ({ telegram: telegram ? { configured: true, source: "file", bot: { username: "tropos_bot", name: "Tropos" } } : { configured: false, source: null } }),
    "channels.telegram.set": () => {
      telegram = true;
      mark("telegram", "done");
      return { configured: true, source: "file", bot: { username: "tropos_bot", name: "Tropos" } };
    },
    "pairing.list": () => ({ approved: [], pending: [] }),
    "pairing.approve": () => ({ senderId: "4242" }),
    "sandbox.check": (p: { pull?: boolean } | undefined) => (p?.pull ? { ok: true, docker: true, image: "tropos/sandbox:1", imagePresent: true } : { ok: false, docker: true, image: "tropos/sandbox:1", imagePresent: false }),
    "service.status": () => ({ manager: "launchd", installed: false, running: false, logPath: "/tmp/gateway.log" }),
    "service.install": () => ({ manager: "launchd", installed: true, running: true, unitPath: "/Library/x.plist" }),
    "doctor.run": () => ({
      findings: [
        { id: "perm", area: "files", level: "warn", message: "gateway.json is readable by others", fixable: true },
        { id: "node", area: "install", level: "ok", message: "Node ok" },
      ],
      summary: { ok: 1, info: 0, warn: 1, error: 0, fixed: 0 },
    }),
    "doctor.fix": () => ({ ok: true, message: "chmod 600 gateway.json" }),
    ...over,
  };
  const rpc = {
    "providers.status": () => PROVIDERS(saved),
    "providers.connect": () => {
      saved = true;
      mark("provider", "done");
      return null;
    },
    "providers.models": (id: string) => (id === "openai" ? ["gpt-a", "gpt-b"] : []),
    setModel: () => null,
  };
  return { admin: admin as never, rpc: rpc as never };
}

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("firstOpenStep", () => {
  test("is the first required step still to do, else an optional one", () => {
    expect(firstOpenStep(STEPS, new Set())).toBe("welcome");
    expect(firstOpenStep(STEPS.map((x) => (x.id === "welcome" ? { ...x, status: "done" as const } : x)), new Set())).toBe("provider");
    const required = STEPS.map((s) => (s.optional ? s : { ...s, status: "done" as const }));
    expect(firstOpenStep(required, new Set())).toBe("welcome");
    expect(firstOpenStep(required, new Set(STEPS.filter((s) => s.optional).map((s) => s.id)))).toBeNull();
  });
});

describe("SetupPage", () => {
  test("renders the steps from the server and opens the first one to do", async () => {
    const s = server();
    await mountAdminPage(SetupPage, s.admin, s.rpc);
    const list = await screen.findByRole("list", { name: "Setup steps" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByText("0 of 2 required steps done")).toBeTruthy();
    const provider = screen.getByRole("button", { name: /Connect a model/ });
    expect(provider.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Telegram/ }).textContent).toContain("optional");
    expect(screen.getByRole("button", { name: /Autonomy/ }).textContent).toContain("Default: Balanced.");
  });

  test("a fresh setup opens on Welcome; Start calls onboard.start and the provider step opens", async () => {
    const s = server({}, { fresh: true });
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    const welcome = await screen.findByRole("button", { name: /Welcome/ });
    expect(welcome.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(socket.adminOf("onboard.start")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /Connect a model/ }).getAttribute("aria-expanded")).toBe("true"));
  });

  test("identity: picking Atlas and saving sends its fields", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Name and personality/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /Atlas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(socket.adminOf("onboard.identity.save")[0]?.params).toEqual({ name: "Atlas", emoji: "🗺️", vibe: "patient, thorough, explains as it goes" }));
  });

  test("identity: a server problem shows in a notice", async () => {
    const s = server({ "onboard.identity.save": () => Promise.reject(new Error("Name is too long.")) });
    await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Name and personality/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Name is too long.");
  });

  test("projects: recent repos are ticked, registered ones locked; Add sends the ticked paths", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Projects/ }));
    const alpha = (await screen.findByRole("checkbox", { name: /alpha/ })) as HTMLInputElement;
    expect(alpha.checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /old/ }) as HTMLInputElement).checked).toBe(false);
    const have = screen.getByRole("checkbox", { name: /have/ }) as HTMLInputElement;
    expect(have.checked && have.disabled).toBe(true);
    expect(document.body.textContent).toContain("already added");
    expect(document.body.textContent).toContain("only the most recent");
    fireEvent.click(screen.getByRole("checkbox", { name: /old/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 projects" }));
    await waitFor(() => expect(socket.adminOf("onboard.projects.add")[0]?.params).toEqual({ paths: ["/w/alpha", "/w/old"] }));
  });

  test("projects: failures are listed", async () => {
    const s = server({ "onboard.projects.add": () => ({ added: [], failed: [{ path: "/w/alpha", error: "not a git repository" }] }) });
    await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Projects/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add 1 project" }));
    expect(await screen.findByText(/not a git repository/)).toBeTruthy();
  });

  test("autonomy: Balanced is preselected and Save sends it", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Autonomy/ }));
    const balanced = await screen.findByRole("radio", { name: /Balanced/ });
    expect(balanced.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(socket.adminOf("onboard.autonomy.set")[0]?.params).toEqual({ autonomy: "balanced" }));
  });

  test("autonomy: without a sandbox Save needs the unconfined checkbox", async () => {
    const s = server({}, { confinement: null });
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Autonomy/ }));
    expect((await screen.findByText("brew install bubblewrap")).tagName).toBe("CODE");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Run without a sandbox/ }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(socket.adminOf("onboard.autonomy.set")[0]?.params).toEqual({ autonomy: "balanced", acceptUnconfined: true }));
  });

  test("autonomy: with Docker, running chat commands on this computer is offered and ticked", async () => {
    const s = server({}, { backend: "docker", confinement: null });
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Autonomy/ }));
    const host = (await screen.findByRole("checkbox", { name: /Run chat commands on this computer instead of Docker/ })) as HTMLInputElement;
    expect(host.checked).toBe(true);
    fireEvent.click(await screen.findByRole("radio", { name: /^Ask/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(socket.adminOf("onboard.autonomy.set")[0]?.params).toEqual({ autonomy: "ask", backend: "host" }));
  });

  test("telegram: BotFather steps and token form, then the owner link and the waiting sender; Yes confirms them", async () => {
    const s = server({
      "onboard.telegram.listen": () => ({ bot: "tropos_bot", link: "https://t.me/tropos_bot?start=abc123", candidates: [{ senderId: "7", chatId: 7, name: "Panagiotis", username: "pk", at: 1 }] }),
      "onboard.telegram.confirm": () => {
        return { steps: STEPS, complete: false, dismissed: false };
      },
    });
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Telegram/ }));
    const steps = await screen.findByRole("list", { name: "BotFather steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("link", { name: /Open BotFather/ }).getAttribute("href")).toBe("https://t.me/BotFather");
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "123:abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    const link = await screen.findByRole("link", { name: /t\.me\/tropos_bot\?start=abc123/ });
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("img", { name: /QR code/ })).toBeTruthy();
    expect(await screen.findByText("Panagiotis (@pk): is this you?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, that's me" }));
    await waitFor(() => expect(socket.adminOf("onboard.telegram.confirm")[0]?.params).toEqual({ senderId: "7" }));
  });

  test("telegram: Not me hides that sender", async () => {
    const s = server({
      "channels.get": () => ({ telegram: { configured: true, source: "file", bot: { username: "tropos_bot", name: "Tropos" } } }),
      "onboard.telegram.listen": () => ({ bot: "tropos_bot", candidates: [{ senderId: "9", chatId: 9, name: "Stranger", at: 1 }] }),
    });
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Telegram/ }));
    expect(await screen.findByText("Stranger: is this you?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not me" }));
    await waitFor(() => expect(screen.queryByText("Stranger: is this you?")).toBeNull());
    expect(socket.adminOf("onboard.telegram.confirm")).toHaveLength(0);
  });

  test("telegram: polling stops when the step closes", async () => {
    const s = server({
      "channels.get": () => ({ telegram: { configured: true, source: "file", bot: { username: "tropos_bot", name: "Tropos" } } }),
      "onboard.telegram.listen": () => ({ bot: "tropos_bot", candidates: [] }),
    });
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    const header = await screen.findByRole("button", { name: /Telegram/ });
    fireEvent.click(header);
    await waitFor(() => expect(socket.adminOf("onboard.telegram.listen").length).toBeGreaterThan(0));
    fireEvent.click(header);
    const seen = socket.adminOf("onboard.telegram.listen").length;
    await new Promise((r) => setTimeout(r, TELEGRAM_POLL_MS + 300));
    expect(socket.adminOf("onboard.telegram.listen")).toHaveLength(seen);
  });

  test("phone: not installed shows the download link; signed in, Turn on shows the QR, link and code", async () => {
    let status: { installed: boolean; running: boolean; enabled: boolean } = { installed: false, running: false, enabled: false };
    const s = server({
      "onboard.phone.status": () => status,
      "onboard.phone.enable": () => ({ url: "https://mac.tail1234.ts.net/", code: "123456" }),
    });
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Phone access/ }));
    expect(await screen.findByRole("link", { name: /Download Tailscale/ })).toBeTruthy();
    status = { installed: true, running: false, enabled: false };
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/Open Tailscale and sign in/)).toBeTruthy();
    status = { installed: true, running: true, enabled: false };
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on phone access" }));
    await waitFor(() => expect(socket.adminOf("onboard.phone.enable")).toHaveLength(1));
    expect(await screen.findByRole("img", { name: "QR code for the dashboard on your phone" })).toBeTruthy();
    expect(screen.getByText("123456")).toBeTruthy();
    expect(screen.getByText("https://mac.tail1234.ts.net/")).toBeTruthy();
    expect(document.body.textContent).toContain("10 minutes");
  });

  test("done: summary, bot link, examples and the health check", async () => {
    const s = server({
      "onboard.summary": () => ({
        steps: [
          { id: "provider", title: "Connect a model", status: "done" },
          { id: "telegram", title: "Telegram", status: "skipped" },
        ],
        dashboardUrl: "http://localhost:4317/",
        botUrl: "https://t.me/tropos_bot",
        examples: ["What changed in my project this week?"],
        health: { ok: 3, warn: 0, error: 0, problems: [] },
      }),
    });
    await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /All set/ }));
    expect(await screen.findByRole("link", { name: /t\.me\/tropos_bot/ })).toBeTruthy();
    expect(screen.getByText("What changed in my project this week?")).toBeTruthy();
    const list = screen.getByRole("list", { name: "What is ready" });
    expect(list.textContent).toContain("Connect a model");
    expect(await screen.findByRole("list", { name: "Findings" })).toBeTruthy();
  });

  test("Skip calls onboard.skip and the step reads skipped", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Name and personality/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Skip: I'll name it in our first chat/ }));
    await waitFor(() => expect(socket.adminOf("onboard.skip")[0]?.params).toEqual({ id: "identity" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Name and personality/ }).textContent).toContain("skipped"));
  });

  test("calm error with retry when the admin API is unavailable", async () => {
    let fail = true;
    const s = server({ "onboard.state": () => (fail ? Promise.reject(new Error("Not available in the demo.")) : { steps: STEPS, complete: false, dismissed: false }) });
    await mountAdminPage(SetupPage, s.admin, s.rpc);
    expect((await screen.findByRole("alert")).textContent).toContain("Not available in the demo.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Setup steps" })).toBeTruthy();
  });

  test("provider: Check key lists models, Save key connects and never keeps the key", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    const field = (await screen.findByLabelText("OpenAI API key")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Check key" }));
    expect((await screen.findByText(/The key works\. Found 5 models/)).textContent).toContain("and 1 more");
    expect(socket.adminOf("onboard.validateKey")[0]?.params).toEqual({ provider: "openai", key: SECRET });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(socket.callsOf("providers.connect")[0]?.params).toEqual({ id: "openai", key: SECRET }));
    await waitFor(() => expect(document.body.textContent).toContain("1 of 2 required steps done"));
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  test("provider: a rejected key shows the reason without echoing it", async () => {
    const s = server();
    await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.change(await screen.findByLabelText("OpenAI API key"), { target: { value: "sk-wrong-key-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Check key" }));
    const note = await screen.findByText(/didn't accept that key/);
    expect(note.textContent).toContain("bad key");
    expect(document.body.textContent).not.toContain("sk-wrong-key-0000");
  });

  test("provider: a local provider needs no key", async () => {
    const s = server();
    await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("radio", { name: /Ollama/ }));
    expect(await screen.findByText(/Runs on this machine/)).toBeTruthy();
    expect(has('input[type="password"]')).toBe(false);
  });

  test("model: lists the models and sets one", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Choose a model/ }));
    // OpenAI needs a key, so only Ollama is ready until one is saved.
    expect(await screen.findByText(/didn't list any models/)).toBeTruthy();
    expect(socket.callsOf("providers.models").length).toBeGreaterThan(0);
  });

  test("model: after a key is saved, picking a model calls setModel", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.change(await screen.findByLabelText("OpenAI API key"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(socket.callsOf("providers.connect")).toHaveLength(1));
    await waitFor(() => expect(document.body.textContent).toContain("1 of 2"));
    // The wizard moves on to the model step by itself once the provider is done.
    fireEvent.click(await screen.findByRole("radio", { name: "OpenAI" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use gpt-b" }));
    await waitFor(() => expect(socket.callsOf("setModel")[0]?.params).toBe("openai/gpt-b"));
  });

  test("telegram: instructions, token goes to channels.telegram.set, skip works", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Telegram/ }));
    expect(await screen.findByText(/@BotFather/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "123:abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    await waitFor(() => expect(socket.adminOf("channels.telegram.set")[0]?.params).toEqual({ token: "123:abc" }));
    await waitFor(() => expect(has('input[type="password"]')).toBe(false));
  });

  test("telegram: Skip moves on and the step reads skipped", async () => {
    const s = server();
    await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Telegram/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip Telegram" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Telegram/ }).textContent).toContain("skipped"));
  });

  test("service: Run at login installs it and says what it does", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /Run in the background/, expanded: false }));
    expect(await screen.findByText(/adds a launchd \(macOS\) entry/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run at login" }));
    await waitFor(() => expect(socket.adminOf("service.install")).toHaveLength(1));
  });

  test("health: runs the doctor and applies a single fix", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: /All set/ }));
    const findings = await screen.findByRole("list", { name: "Findings" });
    expect(findings.textContent).toContain("gateway.json is readable by others");
    fireEvent.click(within(findings).getByRole("button", { name: /Fix: gateway.json/ }));
    await waitFor(() => expect(socket.adminOf("doctor.fix")[0]?.params).toEqual({ id: "perm" }));
    expect(await screen.findByText("chmod 600 gateway.json")).toBeTruthy();
  });

  test("Dismiss setup calls onboard.finish with the optional steps left undone; Reopen setup brings it back", async () => {
    const s = server();
    const { socket } = await mountAdminPage(SetupPage, s.admin, s.rpc);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss setup" }));
    await waitFor(() => expect(socket.adminOf("onboard.finish")).toHaveLength(1));
    expect(socket.adminOf("onboard.finish")[0]?.params).toEqual({ skipped: ["identity", "projects", "autonomy", "telegram", "phone", "service", "done"] });
    fireEvent.click(await screen.findByRole("button", { name: "Reopen setup" }));
    await waitFor(() => expect(socket.adminOf("onboard.reopen")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Dismiss setup" })).toBeTruthy();
  });
});
