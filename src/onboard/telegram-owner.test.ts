import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeTelegramServer } from "../../test/helpers/telegram-fake-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { OwnerClaimStore, type OwnerCandidateView } from "../gateway/owner-claim";
import { FilePairing } from "../gateway/pairing";
import { OnboardError } from "./engine";
import { testDeps } from "./testing";
import { BotBusyError, OWNER_GREETING, confirmOwner, describeCandidate, nextOwnerCandidate, telegramListenMode } from "./telegram-owner";

let home: string;
let server: FakeTelegramServer;
beforeEach(async () => {
  home = await makeTmpDir("tg-owner-");
  server = new FakeTelegramServer();
});
afterEach(async () => {
  server.stop();
  await removeDir(home);
});

const cand = (senderId: string, chatId = 1): OwnerCandidateView => ({ senderId, chatId, name: `n${senderId}`, at: 1 });
const deps = () => testDeps(home, { telegramBaseUrl: server.baseUrl });

describe("nextOwnerCandidate", () => {
  test("direct: the first private human sender, with names; excluded ids skipped; acknowledged", async () => {
    server.pushMessage(-100, 5, "group", { chatType: "group" });
    server.pushMessage(42, 9, "me first");
    server.pushMessage(42, 7, "hi", { from: { first_name: "Panagiotis", username: "pk" } });
    const c = await nextOwnerCandidate(deps(), server.token, { mode: "direct", signal: AbortSignal.timeout(5_000), exclude: new Set(["9"]) });
    expect(c).toMatchObject({ senderId: "7", chatId: 42, name: "Panagiotis", username: "pk" });
    expect(server.getUpdatesOffsets.at(-1)).toBeGreaterThan(server.getUpdatesOffsets[0]!);
  });

  test("direct: a 409 is a BotBusyError with a plain message", async () => {
    const fetch = (async () => Response.json({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }, { status: 409 })) as unknown as typeof globalThis.fetch;
    const err = await nextOwnerCandidate(testDeps(home, { fetch }), "1:x", { mode: "direct", signal: AbortSignal.timeout(2_000) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotBusyError);
    expect(err).toBeInstanceOf(OnboardError);
    expect((err as Error).message).toContain("Another program is reading this bot's messages");
  });

  test("direct: null when the signal fires first", async () => {
    expect(await nextOwnerCandidate(deps(), server.token, { mode: "direct", signal: AbortSignal.timeout(50) })).toBeNull();
  });

  test("gateway: opens the claim and returns what the gateway recorded; null on timeout", async () => {
    const pending = nextOwnerCandidate(deps(), "1:x", { mode: "gateway", signal: AbortSignal.timeout(2_000), pollMs: 5 });
    await Bun.sleep(20);
    await new OwnerClaimStore(home).add(cand("7"));
    expect((await pending)?.senderId).toBe("7");
    expect(await nextOwnerCandidate(deps(), "1:x", { mode: "gateway", signal: AbortSignal.timeout(30), pollMs: 5, exclude: new Set(["7"]) })).toBeNull();
  });
});

describe("confirmOwner", () => {
  test("approves, sets the owner, closes the claim and greets", async () => {
    await new OwnerClaimStore(home).open();
    await new OwnerClaimStore(home).add(cand("7", 42));
    await confirmOwner(deps(), server.token, cand("7", 42));
    const pairing = new FilePairing({ path: join(home, "gateway", "pairing.json") });
    expect(await pairing.isApproved("telegram", "7")).toBe(true);
    expect(await pairing.owner()).toEqual({ channel: "telegram", senderId: "7" });
    expect(await new OwnerClaimStore(home).isOpen()).toBe(false);
    expect(server.textsTo(42)).toEqual([OWNER_GREETING]);
  });

  test("refuses someone who did not write during the listening window", async () => {
    const store = new OwnerClaimStore(home);
    await store.open();
    await store.add(cand("7", 42));
    await expect(confirmOwner(deps(), server.token, cand("8", 43))).rejects.toThrow(OnboardError);
    await expect(confirmOwner(deps(), server.token, { ...cand("7", 99) })).rejects.toThrow(OnboardError); // wrong chat
    const pairing = new FilePairing({ path: join(home, "gateway", "pairing.json") });
    expect(await pairing.isApproved("telegram", "8")).toBe(false);
    expect(await pairing.owner()).toBeNull();
    expect(server.sent).toEqual([]);
  });

  test("refuses once the window has expired", async () => {
    const past = Date.now() - 11 * 60_000;
    const store = new OwnerClaimStore(home, () => past);
    await store.open();
    await store.add(cand("7", 42)); // recorded inside its window, which has since closed
    await expect(confirmOwner(deps(), server.token, cand("7", 42))).rejects.toThrow(OnboardError);
    expect(await new FilePairing({ path: join(home, "gateway", "pairing.json") }).isApproved("telegram", "7")).toBe(false);
  });
});

describe("direct mode confirmation", () => {
  test("a sender caught by direct polling can be confirmed", async () => {
    server.pushMessage(42, 7, "hi");
    const d = deps();
    const c = await nextOwnerCandidate(d, server.token, { mode: "direct", signal: AbortSignal.timeout(5_000) });
    await confirmOwner(d, server.token, c!);
    expect(await new FilePairing({ path: join(home, "gateway", "pairing.json") }).owner()).toEqual({ channel: "telegram", senderId: "7" });
  });
});

describe("telegramListenMode", () => {
  const state = async (s: unknown) => {
    await mkdir(join(home, "gateway"), { recursive: true });
    await writeFile(join(home, "gateway", "state.json"), JSON.stringify(s));
  };
  test("gateway whenever the gateway process is alive (state.telegram can be stale); otherwise direct", async () => {
    await state({ pid: 4242, telegram: true });
    expect(await telegramListenMode(testDeps(home, { alive: (p) => p === 4242 }))).toBe("gateway");
    await state({ pid: 4242, telegram: false });
    expect(await telegramListenMode(testDeps(home, { alive: (p) => p === 4242 }))).toBe("gateway");
    expect(await telegramListenMode(testDeps(home, { alive: () => false }))).toBe("direct");
  });
  test("direct with no or unreadable state", async () => {
    expect(await telegramListenMode(testDeps(home))).toBe("direct");
    await state("garbage");
    expect(await telegramListenMode(testDeps(home, { alive: () => true }))).toBe("direct");
  });
});

test("describeCandidate", () => {
  expect(describeCandidate({ ...cand("7"), name: "Panagiotis K", username: "pk" })).toBe("Panagiotis K (@pk)");
  expect(describeCandidate({ ...cand("7"), name: "Panagiotis K" })).toBe("Panagiotis K");
  expect(describeCandidate({ ...cand("7"), name: "" })).toBe("Telegram user 7");
});
