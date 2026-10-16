import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { byId, fakeRunner, makeFixture, runOne, type Fixture } from "../testing";
import { securityGatewayCheck } from "./security-gateway";
import { securityPairingCheck } from "./security-pairing";
import { isBroadRule, securitySettingsCheck } from "./security-settings";
import { securityWorkspaceCheck } from "./security-workspace";

let fx: Fixture;
afterEach(() => fx?.close());

test("audit checks only run when asked for by area", async () => {
  const { selectChecks } = await import("../engine");
  expect(selectChecks([securityGatewayCheck], undefined)).toEqual([]);
  expect(selectChecks([securityGatewayCheck], "security")).toHaveLength(1);
});

test("gateway: strong token, no network, digest pinning", async () => {
  fx = await makeFixture();
  await fx.write("gateway/token", "a".repeat(8) + "B7xQ-9zLm2".repeat(4) + "\n");
  await fx.write("gateway.json", JSON.stringify({ sandbox: { network: "none", image: "alpine@sha256:abc" } }));
  const r = await runOne(fx, securityGatewayCheck);
  expect(byId(r, "security.gateway.token")!.level).toBe("ok");
  expect(byId(r, "security.gateway.network")!.level).toBe("ok");
  expect(byId(r, "security.gateway.image")!.level).toBe("ok");
});

test("gateway: weak token, bridge network, token in the file, unpinned image", async () => {
  fx = await makeFixture();
  await fx.write("gateway/token", "short\n");
  await fx.write("gateway.json", JSON.stringify({ sandbox: { network: "bridge" }, telegram: { botToken: "9:very-secret" } }));
  const r = await runOne(fx, securityGatewayCheck);
  expect(byId(r, "security.gateway.token")!.level).toBe("warn");
  expect(byId(r, "security.gateway.network")!.level).toBe("warn");
  expect(byId(r, "security.gateway.telegram")!.level).toBe("info");
  expect(byId(r, "security.gateway.image")).toMatchObject({ level: "info", message: expect.stringContaining("alpine:3.22") });
  expect(JSON.stringify(r)).not.toContain("very-secret");
  expect(JSON.stringify(r)).not.toContain("short\\n");
});

test("pairing: counts senders and flags those older than 90 days", async () => {
  fx = await makeFixture();
  const now = Date.UTC(2026, 9, 15);
  const day = 86_400_000;
  await fx.write("gateway/pairing.json", JSON.stringify({ approved: [{ channel: "telegram", senderId: "1", approvedAt: now - 10 * day }, { channel: "telegram", senderId: "2", approvedAt: now - 100 * day }] }));
  const r = await runOne(fx, securityPairingCheck);
  expect(byId(r, "security.pairing")!.message).toBe("2 approved senders");
  expect(byId(r, "security.pairing.old")).toMatchObject({ level: "warn", message: expect.stringContaining("1 sender was") });
  expect(JSON.stringify(r)).not.toContain('"senderId"');
});

test("pairing: none, and a broken file", async () => {
  fx = await makeFixture();
  expect((await runOne(fx, securityPairingCheck)).findings[0]!.level).toBe("ok");
  await fx.write("gateway/pairing.json", "[1]");
  expect((await runOne(fx, securityPairingCheck)).findings[0]!.level).toBe("warn");
});

test("isBroadRule", () => {
  for (const r of ["Bash", "Bash(*)", "Bash(**)", "Edit", "Write", "Write(*)", "*", "mcp__*", "Bash( * )"]) expect(isBroadRule(r)).toBe(true);
  for (const r of ["Bash(git status:*)", "Read", "Edit(src/**)", "WebFetch(domain:example.com)", "Bash(npm test)"]) expect(isBroadRule(r)).toBe(false);
});

test("settings: broad allow rules, bypass default, hooks and MCP servers", async () => {
  fx = await makeFixture();
  await fx.write(
    "settings.json",
    JSON.stringify({
      permissions: { allow: ["Bash", "Read", "Edit(src/**)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
      mcpServers: { files: { command: "mcp-files" }, web: { type: "http", url: "https://x.example/mcp?k=1" } },
    }),
  );
  const r = await runOne(fx, securitySettingsCheck);
  expect(byId(r, "security.settings.allow")).toMatchObject({ level: "warn", message: expect.stringContaining("Bash (user)") });
  expect(String(byId(r, "security.settings.allow")!.message)).not.toContain("Read");
  expect(byId(r, "security.settings.bypass")!.level).toBe("ok");
  expect(byId(r, "security.settings.hooks")).toMatchObject({ level: "info", detail: "PreToolUse: echo hi" });
  const mcp = byId(r, "security.settings.mcp")!;
  expect(mcp.message).toContain("files (mcp-files)");
  expect(mcp.message).not.toContain("?k=1");
});

test("settings: a bypass default is flagged; a clean config is ok", async () => {
  fx = await makeFixture();
  expect(byId(await runOne(fx, securitySettingsCheck), "security.settings.allow")!.level).toBe("ok");
  await fx.write("settings.json", JSON.stringify({ env: { A: "1" }, defaultMode: "bypass" }));
  const r = await runOne(fx, securitySettingsCheck);
  // Unknown keys may be rejected by the settings schema; the raw scan still sees the bypass value.
  expect(byId(r, "security.settings.bypass")!.level).toBe("warn");
});

test("workspace: home, world-writable and no .git are each flagged", async () => {
  fx = await makeFixture();
  const open = join(fx.root, "open");
  await mkdir(join(open, ".git"), { recursive: true });
  await chmod(open, 0o777);
  const nogit = join(fx.root, "nogit");
  await mkdir(nogit);
  const projects = [{ id: "home", path: fx.userHome }, { id: "open", path: open }, { id: "nogit", path: nogit }];
  const r = await runOne(fx, securityWorkspaceCheck, { runner: fakeRunner({ listProjects: async () => projects.map((p) => ({ ...p, name: p.id })) }) });
  expect(byId(r, "security.workspace.home")!.level).toBe("error");
  expect(byId(r, "security.workspace.open.writable")!.level).toBe("warn");
  expect(byId(r, "security.workspace.nogit.git")!.level).toBe("warn");
});
