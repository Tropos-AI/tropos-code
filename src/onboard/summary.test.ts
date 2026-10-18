import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeTelegramServer } from "../../test/helpers/telegram-fake-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { exampleAsks } from "./copy";
import { botUsername, setupSummary } from "./summary";
import { testDeps } from "./testing";

let home: string;
let server: FakeTelegramServer;
beforeEach(async () => {
  home = await makeTmpDir("summary-");
  server = new FakeTelegramServer();
});
afterEach(async () => {
  server.stop();
  await removeDir(home);
});

const writeGateway = (cfg: object) => writeFile(join(home, "gateway.json"), JSON.stringify(cfg));

describe("setupSummary", () => {
  test("steps without welcome and done, the dashboard on 4317 or webPort, the bot link, three examples naming the first project", async () => {
    const app = join(home, "app");
    await mkdir(app);
    await writeGateway({ telegram: { botToken: server.token }, projects: [{ id: "app", name: "app", path: app }] });
    const s = await setupSummary(testDeps(home, { telegramBaseUrl: server.baseUrl }));
    expect(s.steps.map((x) => x.id)).toEqual(["provider", "model", "identity", "projects", "autonomy", "telegram", "phone", "service"]);
    expect(s.steps.find((x) => x.id === "projects")).toMatchObject({ status: "done", detail: "1 project" });
    expect(s.dashboardUrl).toBe("http://localhost:4317");
    expect(s.botUrl).toBe("https://t.me/tropos_bot");
    expect(s.examples).toEqual(exampleAsks("app"));
    expect(s.examples).toHaveLength(3);
    expect(s.health).toEqual({ ok: 0, warn: 0, error: 0, problems: [] });
    await writeGateway({ webPort: 4400 });
    expect((await setupSummary(testDeps(home))).dashboardUrl).toBe("http://localhost:4400");
  });

  test("without a bot there is no bot link; without a project the first example is general", async () => {
    const s = await setupSummary(testDeps(home));
    expect(s.botUrl).toBeUndefined();
    expect(s.examples[0]).toBe("What changed in my project this week?");
  });

  test("health problems are the first five warnings and errors, in words", async () => {
    const findings = Array.from({ length: 7 }, (_, i) => ({ id: `t.${i}`, level: (i === 0 ? "error" : "warn") as "error" | "warn", message: `problem ${i}` }));
    const deps = testDeps(home, { doctor: { checks: [{ id: "t", area: "t", title: "t", run: async () => findings }] } });
    const s = await setupSummary(deps);
    expect(s.health).toMatchObject({ ok: 0, warn: 6, error: 1 });
    expect(s.health.problems).toEqual(["problem 0", "problem 1", "problem 2", "problem 3", "problem 4"]);
  });
});

describe("botUsername", () => {
  test("asks Telegram with the saved token; null when there is none or Telegram does not answer", async () => {
    expect(await botUsername(testDeps(home, { telegramBaseUrl: server.baseUrl }))).toBeNull();
    await writeGateway({ telegram: { botToken: server.token } });
    expect(await botUsername(testDeps(home, { telegramBaseUrl: server.baseUrl }))).toBe("tropos_bot");
    await writeGateway({ telegram: { botToken: "999:wrong" } });
    expect(await botUsername(testDeps(home))).toBeNull();
  });
});
