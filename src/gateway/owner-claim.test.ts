import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { TgMessage } from "./telegram/api";
import { OwnerClaimStore, candidateFrom, ownerClaimPath, type OwnerCandidateView } from "./owner-claim";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("owner-claim-");
});
afterEach(() => removeDir(home));

const cand = (senderId: string, chatId = 1): OwnerCandidateView => ({ senderId, chatId, name: `n${senderId}`, at: 1 });

describe("OwnerClaimStore", () => {
  test("open → add → candidates, one per sender, at most five, closed after 10 minutes, file 0600", async () => {
    let t = 0;
    const store = new OwnerClaimStore(home, () => t);
    await store.add(cand("0"));
    expect(await store.candidates()).toEqual([]); // closed: ignored
    await store.open();
    for (const id of ["1", "2", "3", "4", "5", "6", "2"]) await store.add(cand(id));
    expect((await store.candidates()).map((c) => c.senderId)).toEqual(["2", "6", "5", "4", "3"]);
    expect(((await stat(ownerClaimPath(home))).mode & 0o777).toString(8)).toBe("600");
    t += 10 * 60_000 + 1;
    expect(await store.isOpen()).toBe(false);
    expect(await store.candidates()).toEqual([]);
    await store.add(cand("9")); // expired: ignored
    await store.open();
    expect((await store.candidates()).map((c) => c.senderId)).toContain("2"); // reopening keeps candidates
    await writeFile(ownerClaimPath(home), "{oops");
    expect(await store.candidates()).toEqual([]);
    expect(await store.isOpen()).toBe(false);
  });

  test("close deletes the file; a later add is ignored", async () => {
    const store = new OwnerClaimStore(home);
    await store.open();
    await store.add(cand("1"));
    await store.close();
    expect(await stat(ownerClaimPath(home)).catch(() => null)).toBeNull();
    await store.add(cand("2"));
    expect(await store.candidates()).toEqual([]);
  });
});

describe("candidateFrom", () => {
  const msg = (over: Partial<TgMessage>): TgMessage => ({ message_id: 1, chat: { id: 42, type: "private" }, from: { id: 7, first_name: "Pan", last_name: "K", username: "pk" }, text: "hi", ...over });
  test("joins names and keeps the username", () => {
    expect(candidateFrom(msg({}), 5)).toEqual({ senderId: "7", chatId: 42, name: "Pan K", username: "pk", at: 5 });
  });
  test("skips bots, groups and messages without a sender", () => {
    expect(candidateFrom(msg({ from: { id: 7, is_bot: true } }), 5)).toBeNull();
    expect(candidateFrom(msg({ chat: { id: -1, type: "group" } }), 5)).toBeNull();
    expect(candidateFrom(msg({ from: undefined }), 5)).toBeNull();
  });
});
