// End to end: the host-area handlers behind the real web server, reached by a WebSocket logged in with a device key.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeRuntime } from "../../../test/helpers/fake-runtime";
import { openAuthed, testAccess } from "../../../test/helpers/web-client";
import { dockerCheck } from "../../doctor/checks/docker";
import { WebHost } from "../host";
import { startWebServer, type RunningWebServer } from "../server";
import { channelsHandlers } from "./channels";
import { configHandlers } from "./config";
import { doctorHandlers } from "./doctor";
import { fakeService, makeKit, ok, type Kit } from "./host-testkit";
import { createAdmin } from "./index";
import { pairingHandlers } from "./pairing";
import { projectsHandlers } from "./projects";
import { serviceHandlers } from "./service";
import { statusHandlers } from "./status";

let kit: Kit;
let server: RunningWebServer | null = null;
let sockets: WebSocket[] = [];
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(async () => {
  for (const s of sockets) s.close();
  sockets = [];
  await server?.stop();
  server = null;
  await kit.close();
});

const telegram = (async () => new Response(JSON.stringify({ ok: true, result: { id: 1, first_name: "B", username: "b_bot" } }))) as unknown as typeof fetch;

async function client() {
  const runner = { exec: async () => ok("27"), pidAlive: () => false };
  const service = fakeService();
  const ctx = kit.ctx;
  const admin = createAdmin(ctx, {
    ...statusHandlers(ctx, { service, runner, checks: [dockerCheck] }),
    ...doctorHandlers(ctx, { service, runner, checks: [dockerCheck] }),
    ...configHandlers(ctx),
    ...channelsHandlers(ctx, { fetch: telegram }),
    ...pairingHandlers(ctx),
    ...projectsHandlers(ctx),
    ...serviceHandlers(ctx, { service, runner, git: async () => {} }),
  });
  // The login state lives beside the kit's home, not in it.
  const { devices, logins, key } = await testAccess(join(kit.root, "access"));
  server = await startWebServer({ host: new WebHost(fakeRuntime([])), admin, assets: new Map(), devices, logins, port: 0 });
  const socket = await openAuthed(`http://127.0.0.1:${server.port}`, key);
  sockets.push(socket.ws);
  let id = 0;
  return (method: string, params?: unknown): Promise<any> => {
    const n = ++id;
    socket.send({ t: "admin", id: n, method, params });
    return socket.next((m) => m.t === "admin_result" && m.id === n, 5000);
  };
}

test("status and doctor over the socket", async () => {
  const call = await client();
  const s = await call("status.get");
  expect(s).toMatchObject({ ok: true, result: { version: "1.2.3", needsOnboarding: true, service: { manager: "launchd" }, docker: { ok: true } } });
  const d = await call("doctor.run", { only: "docker" });
  expect(d.ok).toBe(true);
  expect(d.result.findings[0].id).toBe("docker.daemon");
  expect((await call("doctor.fix", { id: "nope" })).ok).toBe(false);
});

test("config over the socket: set, masked round trip and a parse error with its line", async () => {
  const call = await client();
  await writeFile(join(kit.home, "settings.json"), JSON.stringify({ env: { MY_API_KEY: "real-key-123" } }));
  const raw = await call("config.raw", { file: "settings" });
  expect(raw.result.text).not.toContain("real-key-123");
  expect((await call("config.apply", { file: "settings", text: raw.result.text })).ok).toBe(true);
  expect(JSON.parse(await readFile(join(kit.home, "settings.json"), "utf8")).env.MY_API_KEY).toBe("real-key-123");
  const set = await call("config.set", { file: "settings", path: "autoUpdates", value: false });
  expect(set.result.value.autoUpdates).toBe(false);
  const bad = await call("config.apply", { file: "settings", text: '{\n"a":\n}' });
  expect(bad).toMatchObject({ ok: false });
  expect(bad.error).toContain("line 3");
});

test("channels and pairing over the socket", async () => {
  const call = await client();
  const token = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
  const set = await call("channels.telegram.set", { token });
  expect(set.result).toEqual({ configured: true, source: "file", bot: { username: "b_bot", name: "B" } });
  expect(JSON.stringify(await call("channels.get"))).not.toContain(token);
  expect((await call("pairing.list")).result).toEqual({ approved: [], pending: [] });
  expect((await call("pairing.approve", { channel: "telegram", code: "NOPE" })).error).toBe("Unknown code.");
});

test("projects and service over the socket", async () => {
  const call = await client();
  await mkdir(join(kit.userHome, "proj"), { recursive: true });
  const added = await call("projects.add", { path: join(kit.userHome, "proj") });
  expect(added.result).toMatchObject({ id: "proj", gitRepo: false });
  const browse = await call("projects.browse");
  expect(browse.result.entries.map((e: any) => e.name)).toEqual(["proj"]);
  expect((await call("projects.browse", { path: "/definitely/not/here" })).ok).toBe(false);
  expect((await call("service.start")).error).toContain("isn't installed");
  expect((await call("service.install")).result).toMatchObject({ installed: true, running: true });
  expect((await call("service.status")).result.logPath).toBe(join(kit.home, "gateway", "gateway.log"));
  expect((await call("sandbox.check")).result).toMatchObject({ docker: true });
});
