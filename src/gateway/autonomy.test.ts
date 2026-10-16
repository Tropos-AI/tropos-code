// src/gateway/autonomy.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import {
  AutonomyError,
  RAISE_REFUSED,
  UNCONFINED_CONSENT,
  canRaise,
  effectiveAutonomy,
  ensureChatSettings,
  lowerAutonomy,
  needsUnconfinedConsent,
  pinTestCommands,
  pinnedTestCommands,
  sessionAutonomy,
  setAutonomy,
  setChatBackend,
} from "./autonomy";
import { type GatewayConfig, gatewayConfigPath, loadGatewayConfig, saveGatewayConfig } from "./config";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("gateway-autonomy");
});
afterEach(async () => {
  await removeDir(home);
});

const APPROVED = JSON.stringify({ version: 2, approved: [{ channel: "telegram", senderId: "7", approvedAt: 1 }] });

async function withProject(autonomy?: "ask" | "balanced" | "autonomous"): Promise<GatewayConfig> {
  const base = await loadGatewayConfig(home);
  const config = { ...base, projects: [{ id: "app", name: "app", path: "/w/app", ...(autonomy ? { autonomy } : {}) }] };
  await saveGatewayConfig(home, config);
  return config;
}

describe("levels", () => {
  test("canRaise is true only for an equal or stricter level", () => {
    expect(canRaise("autonomous", "ask")).toBe(true);
    expect(canRaise("balanced", "balanced")).toBe(true);
    expect(canRaise("ask", "balanced")).toBe(false);
    expect(canRaise("balanced", "autonomous")).toBe(false);
  });
  test("effectiveAutonomy: the project's own level wins over chat.autonomy", async () => {
    const config = await withProject("autonomous");
    expect(effectiveAutonomy(config, "app")).toBe("autonomous");
    expect(effectiveAutonomy(config, "default")).toBe("balanced");
    expect(effectiveAutonomy(config, "nope")).toBe("balanced");
  });
  test("pinnedTestCommands: the project's commands, none for others", async () => {
    const base = await loadGatewayConfig(home);
    const config = { ...base, projects: [{ id: "app", name: "app", path: "/w", testCommands: ["bun test"] }] };
    expect(pinnedTestCommands(config, "app")).toEqual(["bun test"]);
    expect(pinnedTestCommands(config, "default")).toEqual([]);
  });
  test("sessionAutonomy: guests are at ask; unconfined without consent is ask; scheduled and owner get the project's level", async () => {
    const config = await withProject("autonomous");
    const at = (role: "owner" | "guest" | "scheduled", confined: boolean, c = config) => sessionAutonomy({ config: c, projectId: "app", role, confined });
    expect(at("guest", true)).toBe("ask");
    expect(at("owner", false)).toBe("ask");
    expect(at("owner", true)).toBe("autonomous");
    expect(at("scheduled", true)).toBe("autonomous");
    expect(at("owner", false, { ...config, chat: { ...config.chat, allowUnconfined: true } })).toBe("autonomous");
  });
  test("needsUnconfinedConsent: only host, no confinement, no consent, and some level above ask", async () => {
    const config = await withProject();
    expect(needsUnconfinedConsent(config, null)).toBe(true);
    expect(needsUnconfinedConsent(config, "bwrap")).toBe(false);
    expect(needsUnconfinedConsent({ ...config, chat: { ...config.chat, allowUnconfined: true } }, null)).toBe(false);
    expect(needsUnconfinedConsent({ ...config, chat: { ...config.chat, backend: "docker" } }, null)).toBe(false);
    const ask = { ...config, chat: { ...config.chat, autonomy: "ask" as const } };
    expect(needsUnconfinedConsent(ask, null)).toBe(false);
    expect(needsUnconfinedConsent({ ...ask, projects: [{ ...config.projects[0]!, autonomy: "autonomous" }] }, null)).toBe(true);
  });
});

describe("ensureChatSettings", () => {
  test("fixes a fresh install at balanced/host before an approved sender appears", async () => {
    await ensureChatSettings(home);
    await mkdir(join(home, "gateway"), { recursive: true });
    await writeFile(join(home, "gateway", "pairing.json"), APPROVED);
    expect((await loadGatewayConfig(home)).chat.autonomy).toBe("balanced");
  });
  test("fixes an existing install at ask/docker and leaves a file that has chat alone", async () => {
    await mkdir(join(home, "gateway"), { recursive: true });
    await writeFile(join(home, "gateway", "pairing.json"), APPROVED);
    await ensureChatSettings(home);
    await rmPairing();
    expect((await loadGatewayConfig(home)).chat).toMatchObject({ autonomy: "ask", backend: "docker" });
    const before = await Bun.file(gatewayConfigPath(home)).text();
    await ensureChatSettings(home);
    expect(await Bun.file(gatewayConfigPath(home)).text()).toBe(before);
  });
  async function rmPairing() {
    await writeFile(join(home, "gateway", "pairing.json"), JSON.stringify({ version: 2, approved: [] }));
  }
});

describe("setAutonomy", () => {
  test("refuses balanced without confinement unless run-unconfined is accepted, and then records the consent", async () => {
    await expect(setAutonomy(home, { level: "balanced", confinement: null })).rejects.toThrow(/run unconfined/);
    await expect(setAutonomy(home, { level: "balanced", confinement: null })).rejects.toThrow(UNCONFINED_CONSENT);
    expect((await setAutonomy(home, { level: "balanced", confinement: null, acceptUnconfined: true })).chat).toMatchObject({ autonomy: "balanced", allowUnconfined: true });
    expect((await loadGatewayConfig(home)).chat.allowUnconfined).toBe(true);
    expect((await setAutonomy(home, { level: "autonomous", confinement: "sandbox-exec" })).chat.autonomy).toBe("autonomous");
  });
  test("ask never needs consent", async () => {
    expect((await setAutonomy(home, { level: "ask", confinement: null })).chat.autonomy).toBe("ask");
  });
  test("sets and clears a project's level; errors for null global, unknown and built-in projects", async () => {
    await withProject();
    expect((await setAutonomy(home, { projectId: "app", level: "autonomous", confinement: "bwrap" })).projects[0]?.autonomy).toBe("autonomous");
    expect((await setAutonomy(home, { projectId: "app", level: null, confinement: "bwrap" })).projects[0]?.autonomy).toBeUndefined();
    await expect(setAutonomy(home, { level: null, confinement: "bwrap" })).rejects.toThrow(AutonomyError);
    await expect(setAutonomy(home, { projectId: "nope", level: "ask", confinement: "bwrap" })).rejects.toThrow(AutonomyError);
    await expect(setAutonomy(home, { projectId: "default", level: "ask", confinement: "bwrap" })).rejects.toThrow(AutonomyError);
    await expect(setAutonomy(home, { projectId: "cwd", level: "ask", confinement: "bwrap" })).rejects.toThrow(AutonomyError);
  });
  test("a project level above ask also needs consent when unconfined", async () => {
    await saveGatewayConfig(home, { ...(await withProject()), chat: { autonomy: "ask", backend: "host" } });
    await expect(setAutonomy(home, { projectId: "app", level: "autonomous", confinement: null })).rejects.toThrow(AutonomyError);
  });
});

describe("setChatBackend", () => {
  test("host without confinement needs consent; docker does not", async () => {
    await setChatBackend(home, { backend: "docker", confinement: null });
    await expect(setChatBackend(home, { backend: "host", confinement: null })).rejects.toThrow(UNCONFINED_CONSENT);
    const done = await setChatBackend(home, { backend: "host", confinement: null, acceptUnconfined: true });
    expect(done.chat).toMatchObject({ backend: "host", allowUnconfined: true });
  });
});

describe("lowerAutonomy", () => {
  test("lowers a project's level, refuses a raise, and the default workspace lowers the global level", async () => {
    await withProject("balanced");
    expect(await lowerAutonomy(home, "app", "ask")).toEqual({ changed: true, level: "ask" });
    expect((await loadGatewayConfig(home)).projects[0]?.autonomy).toBe("ask");
    await expect(lowerAutonomy(home, "app", "balanced")).rejects.toThrow(RAISE_REFUSED);
    expect(await lowerAutonomy(home, "app", "ask")).toEqual({ changed: false, level: "ask" });
    expect(await lowerAutonomy(home, "default", "ask")).toEqual({ changed: true, level: "ask" });
    expect((await loadGatewayConfig(home)).chat.autonomy).toBe("ask");
    await expect(lowerAutonomy(home, "default", "autonomous")).rejects.toThrow(AutonomyError);
  });
});

describe("pinTestCommands", () => {
  test("stores the commands on the project; the default workspace has none", async () => {
    await withProject();
    const config = await pinTestCommands(home, "app", ["bun test", "bun run typecheck"]);
    expect(config.projects[0]?.testCommands).toEqual(["bun test", "bun run typecheck"]);
    expect(pinnedTestCommands(await loadGatewayConfig(home), "app")).toEqual(["bun test", "bun run typecheck"]);
    await expect(pinTestCommands(home, "default", ["x"])).rejects.toThrow(AutonomyError);
    await expect(pinTestCommands(home, "nope", ["x"])).rejects.toThrow(AutonomyError);
  });
});
