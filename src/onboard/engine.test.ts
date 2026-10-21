import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { FilePairing } from "../gateway/pairing";
import { BOOTSTRAP_TEXT, saveIdentity } from "../context/identity";
import { readOnboardingFlags, updateOnboardingFlags } from "./flags";
import { checkSandbox, computeOnboardState, defaultMessages, explainKeyError, finish, installService, listModels, markStarted, phoneEnabled, pickDefaultModel, redactKey, registeredProjectCount, reopen, saveKey, saveModel, saveTelegram, shortModelList, skipStep, telegramState, validateKey, verifyTelegram } from "./engine";
import { STEP_WHY } from "./copy";
import { GOOD_KEY, fakeDocker, fakeMessages, fakeNet, fakeService, testDeps } from "./testing";

let root: string;
let home: string;
beforeEach(async () => {
  root = await makeTmpDir("onboard-");
  home = join(root, ".tropos");
  await mkdir(home, { recursive: true });
});
afterEach(() => removeDir(root));

const stepOf = (s: Awaited<ReturnType<typeof computeOnboardState>>, id: string) => s.steps.find((x) => x.id === id)!;

describe("computeOnboardState", () => {
  test("a bare machine lists the eleven steps in order; only provider and model are required", async () => {
    await mkdir(join(home, "workspace"), { recursive: true });
    await writeFile(join(home, "workspace", "BOOTSTRAP.md"), BOOTSTRAP_TEXT);
    const s = await computeOnboardState(testDeps(home), { health: false });
    expect(s.steps.map((x) => x.id)).toEqual(["welcome", "provider", "model", "identity", "projects", "autonomy", "telegram", "phone", "messages", "service", "done"]);
    expect(s.steps.filter((x) => !x.optional).map((x) => x.id)).toEqual(["provider", "model"]);
    expect(["welcome", "identity", "projects", "autonomy", "telegram", "phone", "done"].map((id) => stepOf(s, id).status)).toEqual(Array(7).fill("todo"));
    expect(s.complete).toBe(false);
    expect(s.dismissed).toBe(false);
    expect(Object.keys(STEP_WHY)).toHaveLength(11);
  });

  test("identity, projects, autonomy, telegram and phone are read from the machine", async () => {
    const appDir = join(root, "app");
    await mkdir(appDir);
    await mkdir(join(home, "workspace"), { recursive: true });
    await writeFile(join(home, "workspace", "BOOTSTRAP.md"), BOOTSTRAP_TEXT);
    await saveIdentity(home, { name: "Ada", emoji: "🦊" });
    await writeFile(join(home, "gateway.json"), JSON.stringify({ projects: [{ id: "app", name: "app", path: appDir }], chat: { autonomy: "balanced", backend: "host" }, telegram: { botToken: "1:x" }, remoteAccess: { tailscale: true } }));
    const pairing = new FilePairing({ path: join(home, "gateway", "pairing.json") });
    await pairing.approveSender("telegram", "7");
    await pairing.setOwner("telegram", "7");
    await updateOnboardingFlags(home, { autonomyChosen: true });
    const s = await computeOnboardState(testDeps(home), { health: false });
    for (const id of ["identity", "projects", "autonomy", "telegram", "phone"]) expect(stepOf(s, id).status).toBe("done");
    expect(stepOf(s, "identity").detail).toBe("🦊 Ada");
    expect(stepOf(s, "projects").detail).toBe("1 project");
    expect(stepOf(s, "autonomy").detail).toBe("Balanced");
    expect(stepOf(s, "telegram").detail).toBe("Bot connected; you are the owner");
    expect(await telegramState(testDeps(home))).toEqual({ token: true, owner: { channel: "telegram", senderId: "7" } });
    expect(await phoneEnabled(home)).toBe(true);
    expect(await registeredProjectCount(home)).toBe(1);
  });

  test.skipIf(process.platform !== "darwin")("the real Texts operations tell a running gateway through the reload signal", async () => {
    const reloads: string[] = [];
    const ops = defaultMessages({ home, userHome: home, env: {}, execPath: "x", fetch, now: Date.now, reload: async () => void reloads.push("reload") });
    // Turning texts off builds nothing, so this never reaches the helper.
    const view = await ops.set(false);
    expect(view).toEqual({ available: true, enabled: false });
    expect(reloads).toEqual(["reload"]);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).messages).toBe(false);
  });

  describe("the Texts step", () => {
    const status = (fullDiskAccess: "yes" | "no" | "unknown") => ({ helper: { installed: true, version: 1, current: 1 }, fullDiskAccess, automation: "unknown" as const, signedIn: "unknown" as const });
    const texts = async (messages: ReturnType<typeof fakeMessages>, settings?: object) => {
      if (settings) await writeFile(join(home, "settings.json"), JSON.stringify(settings));
      return stepOf(await computeOnboardState(testDeps(home, { messages }), { health: false }), "messages");
    };

    test("is skipped away from macOS, without asking Messages anything", async () => {
      const messages = fakeMessages({ platform: "linux" });
      const s = await texts(messages, { messages: true });
      expect(s.status).toBe("skipped");
      expect(s.detail).toBe("Only on macOS");
      expect(messages.calls).toEqual([]);
    });

    test("is to do while texts are off", async () => {
      const messages = fakeMessages({ platform: "darwin" });
      const s = await texts(messages);
      expect(s.status).toBe("todo");
      expect(s.detail).toBe("Optional: let me read your texts and send the ones you approve.");
      expect(messages.calls).toEqual([]);
    });

    test("is done once texts are on and Full Disk Access is allowed; to do while it is not", async () => {
      const done = await texts(fakeMessages({ platform: "darwin", view: { available: true, enabled: true, status: status("yes") } }), { messages: true });
      expect(done.status).toBe("done");
      const waiting = await texts(fakeMessages({ platform: "darwin", view: { available: true, enabled: true, status: status("no") } }));
      expect(waiting.status).toBe("todo");
      expect(waiting.detail).toContain("Full Disk Access");
    });
  });

  test("a bot without an owner, and a Docker chat backend, stay todo with what to do next", async () => {
    await writeFile(join(home, "gateway.json"), JSON.stringify({ telegram: { botToken: "1:x" }, chat: { autonomy: "ask", backend: "docker" } }));
    const s = await computeOnboardState(testDeps(home), { health: false });
    expect(stepOf(s, "telegram").status).toBe("todo");
    expect(stepOf(s, "telegram").detail).toBe("Bot connected. Message it so I can recognise you.");
    expect(stepOf(s, "autonomy").status).toBe("todo");
    expect(stepOf(s, "autonomy").detail).toBe("Chats use Docker today. Running them on this computer is faster and keeps the sandbox.");
  });

  test("autonomy not yet chosen says what the default is; unconfined consent is part of the detail", async () => {
    expect(stepOf(await computeOnboardState(testDeps(home), { health: false }), "autonomy").detail).toBe("Default: Balanced.");
    await writeFile(join(home, "gateway.json"), JSON.stringify({ chat: { autonomy: "autonomous", backend: "host", allowUnconfined: true } }));
    await updateOnboardingFlags(home, { autonomyChosen: true });
    const s = await computeOnboardState(testDeps(home, { confinement: async () => null }), { health: false });
    expect(stepOf(s, "autonomy").detail).toBe("Autonomous on this computer, unconfined");
  });

  test("skipStep records at once and refuses required steps; finish keeps startedAt and reminded; reopen keeps only reminded", async () => {
    const deps = testDeps(home);
    await markStarted(deps);
    await updateOnboardingFlags(home, { reminded: ["phone"] });
    expect(stepOf(await skipStep(deps, "telegram"), "telegram").status).toBe("skipped");
    await expect(skipStep(deps, "model")).rejects.toThrow("This step is needed");
    await finish(deps);
    expect(await readOnboardingFlags(home)).toMatchObject({ startedAt: "2026-10-15T12:00:00.000Z", skipped: ["telegram"], reminded: ["phone"] });
    await reopen(deps);
    expect(await readOnboardingFlags(home)).toEqual({ reminded: ["phone"] });
  });

  test("markStarted fixes the chat settings before anyone is approved", async () => {
    await markStarted(testDeps(home));
    expect(JSON.parse(await readFile(join(home, "gateway.json"), "utf8"))).toHaveProperty("chat");
    expect(stepOf(await computeOnboardState(testDeps(home), { health: false }), "welcome").status).toBe("done");
  });

  test("the done step carries the doctor's verdict only when health is asked for", async () => {
    const doctor = { checks: [{ id: "t", area: "t", title: "t", run: async () => [{ id: "t", level: "warn" as const, message: "w" }] }] };
    const deps = testDeps(home, { doctor });
    expect(stepOf(await computeOnboardState(deps), "done").status).toBe("warn");
    expect(stepOf(await computeOnboardState(deps, { health: true }), "done").detail).toBe("1 warning");
    expect(stepOf(await computeOnboardState(deps, { health: false }), "done").status).toBe("todo");
    const bad = testDeps(home, { doctor: { checks: [{ id: "t", area: "t", title: "t", run: async () => [{ id: "t", level: "error" as const, message: "e" }] }] } });
    expect(stepOf(await computeOnboardState(bad), "done").status).toBe("error");
    expect(stepOf(await computeOnboardState(testDeps(home)), "done").status).toBe("done");
  });

  test("an env key makes provider done, and the default model counts when its provider is connected", async () => {
    const s = await computeOnboardState(testDeps(home, { env: { PATH: "", ANTHROPIC_API_KEY: "x" } }));
    expect(stepOf(s, "provider").status).toBe("done");
    expect(stepOf(s, "provider").detail).toContain("$ANTHROPIC_API_KEY");
    expect(stepOf(s, "model").status).toBe("done");
    expect(s.complete).toBe(true);
  });

  test("a saved key for another provider leaves the default (Anthropic) model todo until one is chosen", async () => {
    const deps = testDeps(home);
    await saveKey(deps, { provider: "deepseek", key: GOOD_KEY });
    expect(stepOf(await computeOnboardState(deps), "provider").status).toBe("done");
    expect(stepOf(await computeOnboardState(deps), "model").status).toBe("todo");
    await saveModel(deps, "deepseek/deepseek-chat");
    const s = await computeOnboardState(deps);
    expect(stepOf(s, "model").detail).toBe("deepseek/deepseek-chat");
    expect(s.complete).toBe(true);
  });

  test("a local server that answers counts as a keyless provider", async () => {
    const net = fakeNet();
    const fetch = (async (u: RequestInfo | URL) => (String(u).startsWith("http://localhost:11434") ? Response.json({ data: [] }) : net.fetch(u))) as typeof globalThis.fetch;
    const s = await computeOnboardState(testDeps(home, { fetch }));
    expect(stepOf(s, "provider").status).toBe("done");
    expect(stepOf(s, "provider").detail).toContain("Ollama");
  });

  test("service is read from the machine", async () => {
    const s = await computeOnboardState(testDeps(home, { service: fakeService({ installed: true, running: true }) }), { health: false });
    expect(stepOf(s, "service").detail).toContain("running");
  });

  test("skipped flags turn undone optional steps into skipped, never the required ones", async () => {
    const deps = testDeps(home);
    await finish(deps, { skipped: ["telegram", "provider" as never] });
    const s = await computeOnboardState(deps);
    expect(stepOf(s, "telegram").status).toBe("skipped");
    expect(stepOf(s, "provider").status).toBe("todo");
    expect(s.dismissed).toBe(true);
    expect((await readOnboardingFlags(home)).skipped).toEqual(["telegram"]);
  });

  test("reopen clears the flags", async () => {
    const deps = testDeps(home);
    await finish(deps, { skipped: ["service"] });
    const s = await reopen(deps);
    expect(s.dismissed).toBe(false);
    expect(stepOf(s, "service").status).not.toBe("skipped");
  });

  test("finish records the time from the injected clock", async () => {
    await finish(testDeps(home));
    expect((await readOnboardingFlags(home)).dismissedAt).toBe("2026-10-15T12:00:00.000Z");
  });
});

describe("validateKey", () => {
  test("a good key lists models with one request and saves nothing", async () => {
    const net = fakeNet();
    const r = await validateKey(testDeps(home, { fetch: net.fetch }), { provider: "deepseek", key: GOOD_KEY });
    expect(r).toEqual({ ok: true, models: ["deepseek-chat", "deepseek-reasoner"] });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.auth).toBe(`Bearer ${GOOD_KEY}`);
    expect(await stat(join(home, "credentials.json")).catch(() => null)).toBeNull();
  });

  test("a bad key fails with an error that does not contain the key", async () => {
    const key = "sk-bad-key-987654321";
    const r = await validateKey(testDeps(home), { provider: "deepseek", key });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain(key);
  });

  test("network errors that echo the key are redacted", async () => {
    const key = "sk-echo-key-111111111";
    const fetch = (async () => {
      throw new Error(`connect failed for Bearer ${key} at ${key}`);
    }) as unknown as typeof globalThis.fetch;
    const r = await validateKey(testDeps(home, { fetch }), { provider: "deepseek", key });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(key);
  });

  test("anthropic goes through the SDK seam with exactly that key", async () => {
    let seen = "";
    const deps = testDeps(home, { anthropicModels: async (k) => ((seen = k), ["claude-opus-5-5"]) });
    expect(await validateKey(deps, { provider: "anthropic", key: "sk-ant-abc" })).toEqual({ ok: true, models: ["claude-opus-5-5"] });
    expect(seen).toBe("sk-ant-abc");
    const failing = testDeps(home, { anthropicModels: async (k) => { throw new Error(`401 invalid x-api-key ${k}`); } });
    const r = await validateKey(failing, { provider: "anthropic", key: "sk-ant-secret" });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("sk-ant-secret");
  });

  test("unknown provider, empty key and a key with spaces are refused without a request", async () => {
    const net = fakeNet();
    const deps = testDeps(home, { fetch: net.fetch });
    expect((await validateKey(deps, { provider: "nope", key: "k" })).ok).toBe(false);
    expect((await validateKey(deps, { provider: "deepseek", key: "  " })).ok).toBe(false);
    expect((await validateKey(deps, { provider: "deepseek", key: "a b" })).ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  test("a saved key is used by listModels and written 0600", async () => {
    const deps = testDeps(home);
    await saveKey(deps, { provider: "deepseek", key: GOOD_KEY });
    expect(((await stat(join(home, "credentials.json"))).mode & 0o777).toString(8)).toBe("600");
    expect((await listModels(deps, "deepseek")).ok).toBe(true);
    await expect(saveKey(deps, { provider: "nope", key: "k" })).rejects.toThrow("Unknown provider");
  });
});

describe("helpers", () => {
  test("redactKey", () => expect(redactKey("a sk-1 b Bearer abcdefghijkl", "sk-1")).toBe("a <key> b Bearer <key>"));
  test("pickDefaultModel prefers Anthropic's default, then newest opus, skips non-chat models", () => {
    expect(pickDefaultModel("anthropic", ["claude-haiku-4", "claude-opus-5-5"])).toBe("claude-opus-5-5");
    expect(pickDefaultModel("anthropic", ["claude-opus-4", "claude-opus-4-1", "claude-sonnet-4"])).toBe("claude-opus-4-1");
    expect(pickDefaultModel("openai", ["text-embedding-3", "gpt-x"])).toBe("gpt-x");
    expect(pickDefaultModel("openai", [])).toBeUndefined();
  });
});

describe("telegram, sandbox, service", () => {
  test("verifyTelegram checks getMe and never returns the token", async () => {
    const deps = testDeps(home);
    expect(await verifyTelegram(deps, "123:good")).toEqual({ ok: true, username: "tropos_bot" });
    const bad = await verifyTelegram(deps, "999:secret");
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("999:secret");
  });

  test("saveTelegram writes gateway.json privately and keeps other keys", async () => {
    await writeFile(join(home, "gateway.json"), JSON.stringify({ idleMinutes: 5 }), { mode: 0o600 });
    await saveTelegram(testDeps(home), "123:good");
    const json = JSON.parse(await readFile(join(home, "gateway.json"), "utf8"));
    expect(json).toMatchObject({ idleMinutes: 5, telegram: { botToken: "123:good" } });
    expect(((await stat(join(home, "gateway.json"))).mode & 0o777).toString(8)).toBe("600");
  });

  test("checkSandbox reports no docker, a missing image, and pulls on request", async () => {
    expect((await checkSandbox(testDeps(home))).docker).toBe(false);
    const docker = fakeDocker({ image: false });
    const deps = testDeps(home, { runner: { exec: docker.exec } });
    expect(await checkSandbox(deps)).toMatchObject({ ok: false, docker: true, imagePresent: false });
    expect(await checkSandbox(deps, { pull: true })).toMatchObject({ ok: true, imagePresent: true });
    expect(docker.log.some((c) => c[1] === "pull" && c[2] === "alpine:3.22")).toBe(true);
  });

  test("installService runs the same program arguments as `tcode gateway install` and creates the default project", async () => {
    const service = fakeService();
    await installService(testDeps(home, { service, scriptPath: undefined }));
    expect(service.installed[0]).toMatchObject({ programArguments: ["/fake/bin/tcode", "gateway"], workingDirectory: home });
    expect(service.installed[0]!.logPath).toBe(join(home, "gateway", "gateway.log"));
    expect((await stat(join(home, "workspace"))).isDirectory()).toBe(true);
  });
});

describe("why a key did not validate", () => {
  test("rejected, unreachable and invalid are told apart and explained in plain words", async () => {
    const rejected = await validateKey(testDeps(home), { provider: "deepseek", key: "sk-wrong-wrong-wrong" });
    expect(rejected).toMatchObject({ ok: false, reason: "rejected" });
    expect(explainKeyError("DeepSeek", rejected)).toBe("That key was rejected by DeepSeek. Check you copied all of it.");
    const unreachable = await validateKey(testDeps(home), { provider: "openai", key: "sk-whatever" });
    expect(unreachable).toMatchObject({ ok: false, reason: "unreachable" });
    expect(explainKeyError("OpenAI", unreachable)).toStartWith("Couldn't reach OpenAI (");
    expect(explainKeyError("OpenAI", unreachable)).toEndWith("). Check your internet connection and try again.");
    const empty = await validateKey(testDeps(home), { provider: "deepseek", key: " " });
    expect(empty.reason).toBe("invalid");
    expect(explainKeyError("DeepSeek", empty)).toBe("The API key is empty.");
    expect((await validateKey(testDeps(home), { provider: "deepseek", key: "a b" })).reason).toBe("invalid");
    expect((await validateKey(testDeps(home), { provider: "nope", key: "k" })).reason).toBe("invalid");
  });

  test("a 401 or 403 from Anthropic counts as rejected", async () => {
    const deps = testDeps(home, { anthropicModels: async () => { throw new Error("403 forbidden"); } });
    expect((await validateKey(deps, { provider: "anthropic", key: "sk-ant-x" })).reason).toBe("rejected");
  });
});

describe("shortModelList", () => {
  test("the best model first, then the other chat models in listing order; embeddings are left out", () => {
    const models = ["a-embed-1", "zeta", "deepseek-chat", "beta", "gamma", "delta", "epsilon"];
    expect(shortModelList("deepseek", models, 4)).toEqual(["zeta", "deepseek-chat", "beta", "gamma"]);
    expect(shortModelList("anthropic", ["claude-sonnet-5", "claude-opus-5-5"], 5)).toEqual(["claude-opus-5-5", "claude-sonnet-5"]);
    expect(shortModelList("deepseek", [])).toEqual([]);
  });
});
