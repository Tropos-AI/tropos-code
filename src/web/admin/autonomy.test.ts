import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGatewayConfig, saveGatewayConfig } from "../../gateway/config";
import { ADMIN_METHODS } from "./api";
import { readOnboardingFlags } from "../../onboard/flags";
import { autonomyHandlers } from "./autonomy";
import { adminWith, failure, makeKit, type Kit } from "./host-testkit";

type Probe = "sandbox-exec" | "bwrap" | null;
let kit: Kit;
let probe: Probe;
let appDir: string;
beforeEach(async () => {
  probe = "sandbox-exec";
  kit = await makeKit({ probeConfinement: async () => probe });
  appDir = join(kit.root, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "Cargo.toml"), "");
  const config = await loadGatewayConfig(kit.home);
  await saveGatewayConfig(kit.home, { ...config, projects: [{ id: "app", name: "App", path: appDir }] });
  kit.reloads = 0;
});
afterEach(() => kit.close());
const admin = () => adminWith(kit, autonomyHandlers(kit.ctx));

test("get shows the global level, backend, confinement and each project with detected and pinned tests", async () => {
  const config = await loadGatewayConfig(kit.home);
  await saveGatewayConfig(kit.home, { ...config, projects: config.projects.map((p) => ({ ...p, autonomy: "ask" as const, testCommands: ["cargo test"] })) });
  const view = (await admin().handle("autonomy.get", undefined)) as any;
  expect(view).toMatchObject({ level: "balanced", backend: "host", confinement: "sandbox-exec", unconfinedAccepted: false, unconfined: false });
  expect(view.projects.map((p: any) => p.id)).toEqual(["default", "app"]);
  expect(view.projects[0]).toMatchObject({ builtin: true, effective: "balanced", testCommands: [], detectedTests: [] });
  expect(view.projects[0].level).toBeUndefined();
  expect(view.projects[1]).toMatchObject({ level: "ask", effective: "ask", testCommands: ["cargo test"], detectedTests: ["cargo test"] });
});

test("set raises the global level with confinement, refuses without it unless run-unconfined is accepted, and reloads the gateway", async () => {
  const a = admin();
  expect(((await a.handle("autonomy.set", { level: "autonomous" })) as any).level).toBe("autonomous");
  expect(kit.reloads).toBe(1);
  expect((await loadGatewayConfig(kit.home)).chat.autonomy).toBe("autonomous");

  probe = null;
  expect(await failure(a, "autonomy.set", { level: "balanced" })).toContain("run unconfined");
  expect(kit.reloads).toBe(1);
  const view = (await a.handle("autonomy.set", { level: "balanced", acceptUnconfined: true })) as any;
  expect(view).toMatchObject({ level: "balanced", confinement: null, unconfinedAccepted: true, unconfined: true });
  expect(view.projects[0].effective).toBe("balanced");
  expect(kit.reloads).toBe(2);
  expect(await failure(a, "autonomy.set", { level: "nope" })).toContain("Choose ask");
});

test("without consent the view reports the effective level (ask), not the configured one", async () => {
  probe = null;
  const config = await loadGatewayConfig(kit.home);
  await saveGatewayConfig(kit.home, { ...config, chat: { ...config.chat, autonomy: "autonomous" } });
  const view = (await admin().handle("autonomy.get", undefined)) as any;
  expect(view).toMatchObject({ level: "autonomous", unconfined: false, unconfinedAccepted: false });
  expect(view.projects.every((p: any) => p.effective === "ask")).toBe(true);
});

test("set on a project, and null clears it; an unknown project is an error", async () => {
  const a = admin();
  const set = (await a.handle("autonomy.set", { projectId: "app", level: "autonomous" })) as any;
  expect(set.level).toBe("balanced");
  expect(set.projects.find((p: any) => p.id === "app")).toMatchObject({ level: "autonomous", effective: "autonomous" });
  const cleared = (await a.handle("autonomy.set", { projectId: "app", level: null })) as any;
  const app = cleared.projects.find((p: any) => p.id === "app");
  expect(app.level).toBeUndefined();
  expect(app.effective).toBe("balanced");
  expect(await failure(a, "autonomy.set", { projectId: "ghost", level: "ask" })).toContain("No project");
  expect(kit.reloads).toBe(2);
});

test("setBackend to host on a machine without confinement needs consent when the level is above ask", async () => {
  const a = admin();
  expect(((await a.handle("autonomy.setBackend", { backend: "docker" })) as any).backend).toBe("docker");
  probe = null;
  expect(await failure(a, "autonomy.setBackend", { backend: "host" })).toContain("run unconfined");
  const view = (await a.handle("autonomy.setBackend", { backend: "host", acceptUnconfined: true })) as any;
  expect(view).toMatchObject({ backend: "host", unconfinedAccepted: true, unconfined: true });
  expect(await failure(a, "autonomy.setBackend", { backend: "vm" })).toContain("host or docker");
});

test("confirmTests pins only detected commands; the default workspace has none", async () => {
  const a = admin();
  const pinned = (await a.handle("autonomy.confirmTests", { projectId: "app", commands: ["cargo test"] })) as any;
  expect(pinned.projects.find((p: any) => p.id === "app").testCommands).toEqual(["cargo test"]);
  expect(await failure(a, "autonomy.confirmTests", { projectId: "app", commands: ["rm -rf /"] })).toBe("Only detected test commands can be pinned.");
  expect(await failure(a, "autonomy.confirmTests", { projectId: "default", commands: ["cargo test"] })).toBe("The default workspace has no pinned tests.");
  expect(await failure(a, "autonomy.confirmTests", { projectId: "ghost", commands: [] })).toContain("No project");
  const unpinned = (await a.handle("autonomy.confirmTests", { projectId: "app", commands: [] })) as any;
  expect(unpinned.projects.find((p: any) => p.id === "app").testCommands).toEqual([]);
  expect(kit.reloads).toBe(2);
});

test("the four methods are listed in ADMIN_METHODS and have handlers", () => {
  const names = ["autonomy.get", "autonomy.set", "autonomy.setBackend", "autonomy.confirmTests"];
  for (const n of names) expect(ADMIN_METHODS).toContain(n as any);
  expect(Object.keys(autonomyHandlers(kit.ctx)).sort()).toEqual([...names].sort());
});

test("setting the global level records that the owner chose it; a project level does not", async () => {
  const a = admin();
  await a.handle("autonomy.set", { projectId: "app", level: "balanced" });
  expect((await readOnboardingFlags(kit.home)).autonomyChosen).toBeUndefined();
  await a.handle("autonomy.set", { level: "balanced" });
  expect((await readOnboardingFlags(kit.home)).autonomyChosen).toBe(true);
});
