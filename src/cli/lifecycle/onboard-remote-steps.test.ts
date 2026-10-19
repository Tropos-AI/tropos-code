import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeTelegramServer } from "../../../test/helpers/telegram-fake-server";
import { OwnerClaimStore } from "../../gateway/owner-claim";
import { FilePairing } from "../../gateway/pairing";
import { updateOnboardingFlags } from "../../onboard/flags";
import { TAILSCALE_DOWNLOAD_URL } from "../../onboard/copy";
import { fakeService, fakeTailscale } from "../../onboard/testing";
import { renderQr } from "../../ui/qr";
import { cleanupWizardIO, wizardIO, type TestWizardIO } from "./onboard-test-kit";
import { doneStep, phoneStep, serviceStep, telegramStep } from "./onboard-remote-steps";

let server: FakeTelegramServer;
beforeEach(() => {
  server = new FakeTelegramServer();
});
afterEach(async () => {
  server.stop();
  await cleanupWizardIO();
});

const pairingAt = (home: string) => new FilePairing({ path: join(home, "gateway", "pairing.json") });
const gatewayJson = async (io: TestWizardIO) => JSON.parse(await readFile(join(io.home, "gateway.json"), "utf8"));
const tg = (answers: string[], engine: Parameters<typeof wizardIO>[1] = {}) => wizardIO(answers, { telegramBaseUrl: server.baseUrl, ...engine });
const flat = (text: string) => text.replace(/\n│  /g, " ");

describe("telegramStep", () => {
  test("BotFather, token, then the link: the step moves on at once and the gateway confirms the owner later; the token is never printed", async () => {
    const io = await tg(["", "", server.token]);
    expect(await telegramStep(io)).toBe("next");
    expect(io.opened).toEqual(["https://t.me/BotFather"]);
    expect(io.out()).toContain("/newbot");
    const nonce = io.out().match(/https:\/\/t\.me\/tropos_bot\?start=([A-Za-z0-9_-]+)/)![1];
    expect(io.out()).toContain("Connected to @tropos_bot");
    expect(flat(io.out())).toContain("No need to wait here");
    // Nothing was asked after the token: no "is this you?", no "keep waiting".
    expect(io.questions.some((q) => q.includes("is this you") || q.includes("No message yet"))).toBe(false);
    const store = new OwnerClaimStore(io.home);
    expect(await store.isAuto()).toBe(true);
    expect(await store.nonce()).toBe(nonce!);
    expect(await pairingAt(io.home).owner()).toBeNull();
    expect((await gatewayJson(io)).telegram.botToken).toBe(server.token);
    expect(io.out() + io.err()).not.toContain(server.token);
  });

  test("the link comes with its QR code", async () => {
    const io = await tg(["", "n", server.token]);
    await telegramStep(io);
    const link = io.out().match(/https:\/\/t\.me\/tropos_bot\?start=[A-Za-z0-9_-]+/)![0];
    const qrLine = renderQr(link).split("\n")[4]!;
    expect(io.out()).toContain(qrLine);
  });

  test("a wrong token is explained and asked again; three wrong ones skip the step", async () => {
    const io = await tg(["", "n", "9:bad", "8:bad", "7:bad"]);
    expect(await telegramStep(io)).toBe("skip");
    expect(flat(io.out())).toContain("Telegram didn't accept that token. Copy the whole line BotFather sent; it looks like 123456:ABC-DEF…");
    expect(io.out() + io.err()).not.toContain("9:bad");
    expect(await readFile(join(io.home, "gateway.json"), "utf8").catch(() => "")).not.toContain("bad");
  });

  test("with the token already saved it shows the link without BotFather; with an owner it says so and opens nothing", async () => {
    const io = await tg([""]);
    await writeFile(join(io.home, "gateway.json"), JSON.stringify({ telegram: { botToken: server.token } }));
    expect(await telegramStep(io)).toBe("next");
    expect(io.opened).toEqual([]);
    expect(io.out()).toMatch(/https:\/\/t\.me\/tropos_bot\?start=/);

    const owned = await tg([""]);
    await writeFile(join(owned.home, "gateway.json"), JSON.stringify({ telegram: { botToken: server.token } }));
    await pairingAt(owned.home).approveSender("telegram", "7");
    await pairingAt(owned.home).setOwner("telegram", "7");
    expect(await telegramStep(owned)).toBe("next");
    expect(owned.out()).toContain("You're already the owner of @tropos_bot.");
    expect(await new OwnerClaimStore(owned.home).isOpen()).toBe(false);
  });

  test("declining, going back, and --quick", async () => {
    expect(await telegramStep(await tg(["n"]))).toBe("skip");
    expect(await telegramStep(await tg(["b"]))).toBe("back");
    const quick = await wizardIO([], {}, { quick: true });
    expect(await telegramStep(quick)).toBe("skip");
    expect(quick.questions).toEqual([]);
  });
});

describe("phoneStep", () => {
  const signedIn = () => fakeTailscale({ installed: true, running: true, dnsName: "mac.tail1.ts.net" });
  async function withOwner(io: TestWizardIO) {
    const p = pairingAt(io.home);
    await p.approveSender("telegram", "7");
    await p.setOwner("telegram", "7");
  }

  test("after Telegram, signed in: the QR, the link and the 6-digit code", async () => {
    const ts = signedIn();
    const io = await wizardIO([], { runner: ts });
    await withOwner(io);
    expect(await phoneStep(io)).toBe("next");
    expect(ts.served).toEqual([4317]);
    const url = "https://mac.tail1.ts.net/";
    expect(io.out()).toContain(renderQr(url).split("\n")[4]!);
    expect(io.out()).toContain(url);
    expect(flat(io.out())).toContain("log in with 123456. The code works for 10 minutes.");
    expect(flat(io.out())).toContain("The page answers once Tropos runs in the background (next step).");
  });

  test("not installed: the download page is offered, then Enter checks again and s skips", async () => {
    const io = await wizardIO(["", "s"]);
    await withOwner(io);
    expect(await phoneStep(io)).toBe("skip");
    expect(io.opened).toEqual([TAILSCALE_DOWNLOAD_URL]);
    expect(flat(io.out())).toContain(`Install Tailscale on this computer and on your phone (${TAILSCALE_DOWNLOAD_URL}) and sign in with the same account on both.`);
  });

  test("installed but signed out: asks to open Tailscale; Enter checks again", async () => {
    const io = await wizardIO(["", "s"], { runner: fakeTailscale({ installed: true, running: false }) });
    await withOwner(io);
    expect(await phoneStep(io)).toBe("skip");
    expect(flat(io.out())).toContain("Open Tailscale and sign in, then press Enter.");
    expect(io.questions.length).toBe(2);
  });

  test("without Telegram it asks first and Enter means no", async () => {
    const ts = signedIn();
    const io = await wizardIO([""], { runner: ts });
    expect(await phoneStep(io)).toBe("skip");
    expect(io.questions[0]).toContain("Do you want to open the dashboard from your phone too?");
    expect(ts.served).toEqual([]);
  });

  test("without Telegram, y goes on", async () => {
    const ts = signedIn();
    const io = await wizardIO(["y"], { runner: ts });
    expect(await phoneStep(io)).toBe("next");
    expect(ts.served).toEqual([4317]);
  });

  test("--quick never turns on phone access by itself", async () => {
    const ts = signedIn();
    const io = await wizardIO([], { runner: ts }, { quick: true });
    await withOwner(io);
    expect(await phoneStep(io)).toBe("skip");
    expect(ts.served).toEqual([]);
  });
});

describe("serviceStep", () => {
  test("installs the background service", async () => {
    const service = fakeService();
    const io = await wizardIO([""], { service });
    expect(await serviceStep(io)).toBe("next");
    expect(service.installed).toHaveLength(1);
    expect(io.out()).toContain("/fake/unit.plist");
  });

  test("n skips; a system without a service manager moves on with a plain note", async () => {
    expect(await serviceStep(await wizardIO(["n"], { service: fakeService() }))).toBe("skip");
    const none = { ...fakeService(), manager: "none" as const, status: async () => ({ manager: "none" as const, installed: false, running: false }) };
    const io = await wizardIO([], { service: none });
    expect(await serviceStep(io)).toBe("next");
    expect(io.out()).toContain("Not available here; start Tropos with `tcode gateway` when you need it.");
    expect(io.questions).toEqual([]);
  });

  test("a failed install says what to do instead and skips", async () => {
    const service = fakeService();
    service.install = async () => {
      throw new Error("launchctl said no");
    };
    const io = await wizardIO([""], { service });
    expect(await serviceStep(io)).toBe("skip");
    expect(io.out()).toContain("launchctl said no");
    expect(io.out()).toContain("tcode gateway");
  });
});

describe("doneStep", () => {
  test("summary, health problems, bot link, three examples, then opens the dashboard logged in", async () => {
    const doctor = { checks: [{ id: "t", area: "t", title: "t", run: async () => [{ id: "t", level: "warn" as const, message: "the disk is almost full" }] }] };
    const io = await wizardIO([""], { service: fakeService({ installed: true, running: true }), doctor, telegramBaseUrl: server.baseUrl });
    await writeFile(join(io.home, "gateway.json"), JSON.stringify({ telegram: { botToken: server.token } }));
    await updateOnboardingFlags(io.home, { skipped: ["identity"] });
    await pairingAt(io.home).approveSender("telegram", "7");
    await pairingAt(io.home).setOwner("telegram", "7");
    expect(await doneStep(io)).toBe("next");
    const text = io.out();
    expect(text).toContain("Try asking:");
    expect(text).toContain("Every weekday at 9, summarise my open pull requests.");
    expect(text).toContain("the disk is almost full");
    expect(text).toContain("Run `tcode doctor --fix`.");
    expect(text).toContain("https://t.me/tropos_bot");
    expect(text).toContain("http://localhost:4317");
    expect(text).toMatch(/– .*\(later: `tcode onboard`\)/);
    expect(io.opened).toEqual(["http://localhost:4317/#login=ONE-TIME-KEY"]);
  });

  test("--no-open points to `tcode dashboard`", async () => {
    const io = await wizardIO([], { service: fakeService({ installed: true, running: true }) }, { noOpen: true });
    expect(await doneStep(io)).toBe("next");
    expect(io.opened).toEqual([]);
    expect(io.out()).toContain("Open the dashboard any time with `tcode dashboard`.");
  });

  test("it waits for a service that is still starting, then opens", async () => {
    const service = fakeService({ installed: true, running: false });
    let calls = 0;
    service.status = async () => ({ manager: "launchd" as const, installed: true, running: ++calls > 4 });
    const sleeps: number[] = [];
    const io = await wizardIO([""], { service }, {}, { sleep: async (ms) => void sleeps.push(ms) });
    await doneStep(io);
    expect(sleeps).toEqual([300, 300, 300]);
    expect(io.opened).toHaveLength(1);
  });

  test("a service that never starts: no waiting past 10 tries, no browser", async () => {
    const sleeps: number[] = [];
    const io = await wizardIO([], { service: fakeService({ installed: true, running: false }) }, {}, { sleep: async (ms) => void sleeps.push(ms) });
    await doneStep(io);
    expect(sleeps.length).toBeLessThanOrEqual(10);
    expect(io.opened).toEqual([]);
    expect(io.out()).toContain("Open the dashboard any time with `tcode dashboard`.");
  });
});
