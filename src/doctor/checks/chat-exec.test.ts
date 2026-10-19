import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult } from "../types";
import { byId, fakeRunner, makeFixture, runOne, type Fixture } from "../testing";
import { chatExecCheck } from "./chat-exec";
import { dockerCheck } from "./docker";

let fx: Fixture;
afterEach(() => fx?.close());

const works = async (): Promise<RunResult> => ({ code: 0, stdout: "", stderr: "" });
const broken = async (): Promise<RunResult> => ({ code: null, stdout: "", stderr: "", error: "not found" });
const chat = (c: object) => JSON.stringify({ chat: c });

test("confined on this machine: ok, naming the tool and the level", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "host", autonomy: "balanced" }));
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }), platform: "linux" });
  expect(byId(r, "chat.exec")).toMatchObject({ level: "ok", message: "Chat commands run on this machine, confined by bwrap, at balanced" });
  expect(r.findings.some((f) => f.fixable)).toBe(false);
});

test("confined at autonomous: a note that commands have the network and can read the home folder outside the deny list", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "host", autonomy: "autonomous" }));
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }), platform: "darwin" });
  expect(byId(r, "chat.exec.autonomous")).toMatchObject({
    level: "info",
    message: "At autonomous, chat commands run unasked with network access, and can read your home folder outside the secrets they're denied",
    detail:
      "Keys, tokens, shell histories and your other projects' .env files stay unreadable, but other files in your home folder don't. Lower the level to balanced, or run chats in Docker, if that is too much.",
  });
  expect(byId(r, "chat.exec.autonomous")!.fixable).toBeFalsy();
});

test("a single project at autonomous gets the note too; balanced everywhere doesn't", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", JSON.stringify({ chat: { backend: "host", autonomy: "balanced" }, projects: [{ id: "p", name: "P", path: fx.root, autonomy: "autonomous" }] }));
  const one = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }), platform: "linux" });
  expect(byId(one, "chat.exec.autonomous")).toBeDefined();
  await fx.write("gateway.json", chat({ backend: "host", autonomy: "balanced" }));
  const none = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }), platform: "linux" });
  expect(byId(none, "chat.exec.autonomous")).toBeUndefined();
});

test("Docker at autonomous gets no such note: the container sees only the project", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "docker", autonomy: "autonomous" }));
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }) });
  expect(byId(r, "chat.exec.autonomous")).toBeUndefined();
});

test("macOS names sandbox-exec", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "host", autonomy: "ask" }));
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }), platform: "darwin" });
  expect(byId(r, "chat.exec")!.message).toBe("Chat commands run on this machine, confined by sandbox-exec, at ask");
});

test("Docker backend at a higher level is ok", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "docker", autonomy: "balanced" }));
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }) });
  expect(byId(r, "chat.exec")!.message).toBe("Chat commands run in Docker, at balanced");
  expect(byId(r, "chat.exec.switch")).toBeUndefined();
});

test("Docker at ask offers the switch", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "docker", autonomy: "ask" }));
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }) });
  expect(byId(r, "chat.exec")!.message).toBe("Chat commands run in Docker, at ask");
  expect(byId(r, "chat.exec.switch")).toMatchObject({
    level: "info",
    message: "Chats use Docker and ask before everything. They can run on this Mac without Docker, confined, at a higher autonomy level: Settings → Autonomy, or tcode onboard.",
  });
  expect(byId(r, "chat.exec.switch")!.fixable).toBeFalsy();
});

test("unconfined with consent warns, with the platform's advice", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "host", autonomy: "autonomous", allowUnconfined: true }));
  const linux = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: broken }), platform: "linux" });
  expect(byId(linux, "chat.exec.unconfined")).toMatchObject({
    level: "warn",
    message: "Chat commands run unconfined on this machine",
    detail: "Install bubblewrap (bwrap) to confine them, or lower the autonomy level to ask.",
  });
  const mac = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: broken }), platform: "darwin" });
  expect(byId(mac, "chat.exec.unconfined")!.detail).toBe("sandbox-exec isn't working here; lower the autonomy level to ask.");
});

test("unconfined at ask also warns: the owner's commands still run on the host", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "host", autonomy: "ask" }));
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: broken }) });
  expect(byId(r, "chat.exec.unconfined")!.level).toBe("warn");
  expect(byId(r, "chat.exec.held")).toBeUndefined();
});

test("a higher level without confinement or consent is held at ask", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "host", autonomy: "balanced" }));
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: broken }) });
  expect(byId(r, "chat.exec.held")).toMatchObject({
    level: "info",
    message: "Chats are held at ask: commands can't be confined here and running unconfined wasn't confirmed",
  });
  expect(byId(r, "chat.exec.unconfined")).toBeUndefined();
});

test("a project above ask also counts as needing consent", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", JSON.stringify({ chat: { backend: "host", autonomy: "ask" }, projects: [{ id: "p", name: "P", path: fx.root, autonomy: "balanced" }] }));
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: broken }) });
  expect(byId(r, "chat.exec.held")).toBeDefined();
});

test("a broken gateway.json is left to the gateway check", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", "{ nope");
  const r = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }) });
  expect(r.findings).toEqual([]);
});

test("a linked sandbox-cache tool dir is a fixable finding; fixing removes the link only", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "host", autonomy: "balanced" }));
  const target = join(fx.root, "victim");
  await mkdir(target);
  await mkdir(join(fx.home, "sandbox-cache"), { recursive: true });
  await symlink(target, join(fx.home, "sandbox-cache", "npm"));
  const plain = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }) });
  const f = byId(plain, "chat.exec.cache")!;
  expect(f).toMatchObject({ level: "warn", fixable: true });
  expect(f.message).toContain("npm");
  expect((await lstat(join(fx.home, "sandbox-cache", "npm"))).isSymbolicLink()).toBe(true);

  const fixed = await runOne(fx, chatExecCheck, { runner: fakeRunner({ exec: works }), fix: true });
  expect(fixed.summary.fixed).toBe(1);
  await expect(lstat(join(fx.home, "sandbox-cache", "npm"))).rejects.toThrow();
  expect((await lstat(target)).isDirectory()).toBe(true);
});

test("Docker is optional when chats run on this machine", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "host", autonomy: "balanced" }));
  const r = await runOne(fx, dockerCheck);
  expect(r.findings[0]).toMatchObject({
    level: "info",
    message: "Docker is not installed (optional — needed only for guests' commands)",
    detail: "Optional: chats run on this machine. Docker is only needed if you switch chats to the Docker backend.",
  });
  const down = await runOne(fx, dockerCheck, { runner: fakeRunner({ exec: async () => ({ code: 1, stdout: "", stderr: "Cannot connect" }) }) });
  expect(down.findings[0]).toMatchObject({ level: "info" });
  expect(down.findings[0]!.message).toContain("daemon is not reachable (optional");
});

test("Docker stays a warning when chats use it", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", chat({ backend: "docker", autonomy: "ask" }));
  const r = await runOne(fx, dockerCheck);
  expect(r.findings[0]).toMatchObject({ level: "warn", message: "Docker is not installed" });
});
