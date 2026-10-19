import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { TgMessage } from "./telegram/api";
import { OwnerClaimStore, candidateFrom, claimProof, ownerClaimLink, ownerClaimPath, type OwnerCandidateView } from "./owner-claim";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("owner-claim-");
});
afterEach(() => removeDir(home));

/** Adds with the open window's own secret (or a placeholder when closed, which must not matter). */
const addAs = async (store: OwnerClaimStore, c: OwnerCandidateView, proof?: string) => store.add(c, proof ?? `/start ${(await store.nonce()) ?? "none"}`);
const cand = (senderId: string, chatId = 1, at = 1): OwnerCandidateView => ({ senderId, chatId, name: `n${senderId}`, at });

describe("OwnerClaimStore", () => {
  test("open → add → candidates, one per sender, at most five, closed after 10 minutes, file 0600", async () => {
    let t = 0;
    const store = new OwnerClaimStore(home, () => t);
    await addAs(store, cand("0"));
    expect(await store.candidates()).toEqual([]); // closed: ignored
    await store.open();
    for (const id of ["1", "2", "3", "4", "5", "6", "2"]) await addAs(store, cand(id));
    expect((await store.candidates()).map((c) => c.senderId)).toEqual(["2", "6", "5", "4", "3"]);
    expect(((await stat(ownerClaimPath(home))).mode & 0o777).toString(8)).toBe("600");
    t += 10 * 60_000 + 1;
    expect(await store.isOpen()).toBe(false);
    expect(await store.candidates()).toEqual([]);
    await addAs(store, cand("9")); // expired: ignored
    await store.open();
    expect(await store.candidates()).toEqual([]); // a new window starts empty: nothing from the old one carries over
    await writeFile(ownerClaimPath(home), "{oops");
    expect(await store.candidates()).toEqual([]);
    expect(await store.isOpen()).toBe(false);
  });

  test("extending an open window keeps its candidates and its start", async () => {
    let t = 5_000;
    const store = new OwnerClaimStore(home, () => t);
    await store.open();
    await addAs(store, cand("1", 1, 5_000));
    t += 60_000;
    await store.open();
    expect((await store.candidates()).map((c) => c.senderId)).toEqual(["1"]);
    expect(await store.windowStart()).toBe(5_000);
  });

  test("a message from before the window started is not recorded", async () => {
    const store = new OwnerClaimStore(home, () => 10_000);
    await store.open();
    expect(await addAs(store, cand("old", 1, 8_999))).toBe(false); // a second earlier than the window
    expect(await addAs(store, cand("new", 1, 10_000))).toBe(true);
    expect((await store.candidates()).map((c) => c.senderId)).toEqual(["new"]);
  });

  test("only a sender who sends the secret is recorded", async () => {
    const store = new OwnerClaimStore(home);
    await store.open();
    const nonce = (await store.nonce())!;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{12,}$/);
    expect(await addAs(store, cand("1", 1, Date.now()), "hello")).toBe(false);
    expect(await addAs(store, cand("1", 1, Date.now()), "/start")).toBe(false);
    expect(await addAs(store, cand("1", 1, Date.now()), `/start ${nonce}x`)).toBe(false);
    expect(await addAs(store, cand("1", 1, Date.now()), `/start wrong`)).toBe(false);
    expect(await store.add(cand("1", 1, Date.now()), undefined)).toBe(false);
    expect(await store.candidates()).toEqual([]);
    expect(await addAs(store, cand("2", 1, Date.now()), `/start ${nonce}`)).toBe(true);
    expect(await addAs(store, cand("3", 1, Date.now()), nonce)).toBe(true);
    expect((await store.candidates()).map((c) => c.senderId)).toEqual(["3", "2"]);
  });

  test("a new window has a new secret; the old one no longer works", async () => {
    let t = 0;
    const store = new OwnerClaimStore(home, () => t);
    await store.open();
    const first = (await store.nonce())!;
    t += 11 * 60_000;
    await store.open();
    const second = (await store.nonce())!;
    expect(second).not.toBe(first);
    expect(await addAs(store, cand("1", 1, t), `/start ${first}`)).toBe(false);
  });

  test("a closed window cannot be written to late, and close/add race across two stores is safe", async () => {
    const a = new OwnerClaimStore(home);
    const b = new OwnerClaimStore(home);
    await a.open();
    const nonce = (await a.nonce())!;
    await Promise.all([a.close(), ...["1", "2", "3", "4"].map((id) => b.add(cand(id, 1, Date.now()), `/start ${nonce}`))]);
    expect(await a.isOpen()).toBe(false); // whatever order they ran in, nothing reopened it
    expect(await b.add(cand("9", 1, Date.now()), `/start ${nonce}`)).toBe(false);
    expect(await stat(ownerClaimPath(home)).catch(() => null)).toBeNull();
  });

  test("close deletes the file; a later add is ignored", async () => {
    const store = new OwnerClaimStore(home);
    await store.open();
    await addAs(store, cand("1"));
    await store.close();
    expect(await stat(ownerClaimPath(home)).catch(() => null)).toBeNull();
    await addAs(store, cand("2"));
    expect(await store.candidates()).toEqual([]);
  });
});

test("claimProof and the link", () => {
  expect(claimProof("/start abc", "abc")).toBe(true);
  expect(claimProof(" abc ", "abc")).toBe(true);
  expect(claimProof("/start abcd", "abc")).toBe(false);
  expect(claimProof("start abc", "abc")).toBe(false);
  expect(ownerClaimLink("tropos_bot", "abc")).toBe("https://t.me/tropos_bot?start=abc");
});

describe("candidateFrom", () => {
  const msg = (over: Partial<TgMessage>): TgMessage => ({ message_id: 1, chat: { id: 42, type: "private" }, from: { id: 7, first_name: "Pan", last_name: "K", username: "pk" }, text: "hi", ...over });
  test("joins names and keeps the username", () => {
    expect(candidateFrom(msg({}), 5)).toEqual({ senderId: "7", chatId: 42, name: "Pan K", username: "pk", at: 5 });
  });
  test("takes the time from the message's own date", () => {
    expect(candidateFrom(msg({ date: 1_700_000_000 }), 5)?.at).toBe(1_700_000_000_000);
  });
  test("skips bots, groups and messages without a sender", () => {
    expect(candidateFrom(msg({ from: { id: 7, is_bot: true } }), 5)).toBeNull();
    expect(candidateFrom(msg({ chat: { id: -1, type: "group" } }), 5)).toBeNull();
    expect(candidateFrom(msg({ from: undefined }), 5)).toBeNull();
  });
});

test("an automatic window: a 128-bit secret, open a day; the dashboard opening one turns automatic off", async () => {
  const home = await makeTmpDir("claim-auto-");
  try {
    const store = new OwnerClaimStore(home);
    await store.open({ auto: true });
    const nonce = (await store.nonce())!;
    expect(Buffer.from(nonce, "base64url").length).toBe(16);
    expect(await store.isAuto()).toBe(true);
    await store.open();
    expect(await store.isAuto()).toBe(false);
    expect(await store.nonce()).toBe(nonce);
  } finally {
    await removeDir(home);
  }
});
