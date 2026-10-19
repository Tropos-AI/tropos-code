// src/tools/setup/autonomy.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { loadGatewayConfig } from "../../gateway/config";
import { AutonomyError, RAISE_REFUSED, UNCONFINED_CONSENT } from "../../gateway/autonomy";
import { autonomyRefusal, lowerSetupAutonomy, raiseRefusal } from "./autonomy";
import { SetupRefused } from "./matrix";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

const writeGateway = (h: string, value: unknown) => writeFile(join(h, "gateway.json"), JSON.stringify(value));

test("lowering globally clamps project overrides; raising is refused with the dashboard pointer", async () => {
  await writeGateway(home, { chat: { autonomy: "balanced", backend: "host" }, projects: [{ id: "app", name: "app", path: "/w/app", autonomy: "autonomous" }] });
  expect(await lowerSetupAutonomy(home, "ask")).toEqual({ before: "balanced", after: "ask" });
  expect((await loadGatewayConfig(home)).projects[0]!.autonomy).toBe("ask");
  await expect(lowerSetupAutonomy(home, "autonomous")).rejects.toThrow("Settings → Autonomy");
  await expect(lowerSetupAutonomy(home, "autonomous")).rejects.toBeInstanceOf(SetupRefused);
});

test("one project is lowered alone; a project that is already lower is left as it is", async () => {
  await writeGateway(home, { chat: { autonomy: "autonomous", backend: "host" }, projects: [{ id: "app", name: "app", path: "/w/app" }, { id: "web", name: "web", path: "/w/web", autonomy: "ask" }] });
  expect(await lowerSetupAutonomy(home, "balanced", "app")).toEqual({ before: "autonomous", after: "balanced" });
  const c = await loadGatewayConfig(home);
  expect(c.chat.autonomy).toBe("autonomous");
  expect(c.projects.map((p) => p.autonomy)).toEqual(["balanced", "ask"]);
  await lowerSetupAutonomy(home, "balanced");
  expect((await loadGatewayConfig(home)).projects.map((p) => p.autonomy)).toEqual(["balanced", "ask"]);
});

test("an unknown project is refused instead of lowering the global level", async () => {
  await writeGateway(home, { chat: { autonomy: "balanced", backend: "host" } });
  await expect(lowerSetupAutonomy(home, "ask", "nope")).rejects.toThrow('There is no project "nope"');
  expect((await loadGatewayConfig(home)).chat.autonomy).toBe("balanced");
});

test("each refusal says what it is really about: a raise points at the dashboard, a consent refusal names confinement", () => {
  const config = { webPort: 4317 };
  expect(autonomyRefusal(new AutonomyError(RAISE_REFUSED), config).message).toBe(raiseRefusal(config));
  const consent = autonomyRefusal(new AutonomyError(UNCONFINED_CONSENT), config).message;
  expect(consent).not.toContain("raise");
  expect(consent).toContain("confined");
  expect(consent).toContain("#/settings/autonomy");
  expect(autonomyRefusal(new AutonomyError('No project "x".'), config).message).toBe('No project "x".');
});
