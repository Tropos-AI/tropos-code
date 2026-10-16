import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { readOnboardingFlags } from "./flags";
import { checkSandbox, computeOnboardState, finish, installService, listModels, pickDefaultModel, redactKey, reopen, saveKey, saveModel, saveTelegram, validateKey, verifyTelegram } from "./engine";
import { GOOD_KEY, fakeDocker, fakeNet, fakeService, testDeps } from "./testing";

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
  test("a bare machine: provider and model todo, not complete, optional steps marked optional", async () => {
    const s = await computeOnboardState(testDeps(home));
    expect(stepOf(s, "provider").status).toBe("todo");
    expect(stepOf(s, "model").status).toBe("todo");
    expect(s.complete).toBe(false);
    expect(s.dismissed).toBe(false);
    expect(s.steps.filter((x) => !x.optional).map((x) => x.id)).toEqual(["provider", "model"]);
    expect(stepOf(s, "sandbox").status).toBe("warn");
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

  test("telegram, pairing, sandbox, service and health are read from the machine", async () => {
    await writeFile(join(home, "gateway.json"), JSON.stringify({ telegram: { botToken: "1:x" } }));
    await mkdir(join(home, "gateway"), { recursive: true });
    await writeFile(join(home, "gateway", "pairing.json"), JSON.stringify({ approved: [{ channel: "telegram", senderId: "1" }] }));
    const docker = fakeDocker();
    const s = await computeOnboardState(
      testDeps(home, {
        runner: { exec: docker.exec },
        service: fakeService({ installed: true, running: true }),
        doctor: { checks: [{ id: "t", area: "t", title: "t", run: async () => [{ id: "t", level: "warn", message: "w" }] }] },
      }),
    );
    expect(stepOf(s, "telegram").status).toBe("done");
    expect(stepOf(s, "pairing").detail).toBe("1 approved sender");
    expect(stepOf(s, "sandbox").status).toBe("done");
    expect(stepOf(s, "service").detail).toContain("running");
    expect(stepOf(s, "health").status).toBe("warn");
  });

  test("health is an error when the doctor finds one; docker without the image is todo", async () => {
    const docker = fakeDocker({ image: false });
    const s = await computeOnboardState(
      testDeps(home, { runner: { exec: docker.exec }, doctor: { checks: [{ id: "t", area: "t", title: "t", run: async () => [{ id: "t", level: "error", message: "e" }] }] } }),
    );
    expect(stepOf(s, "health").status).toBe("error");
    expect(stepOf(s, "sandbox").status).toBe("todo");
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
