// src/messages/burst.test.ts — the send ledger's per-recipient and hourly limits
import { describe, expect, test } from "bun:test";
import { SendLedger } from "./burst";

const MARIA = "+306912345678";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 21, 12);

describe("SendLedger", () => {
  test("five texts to one person in 10 minutes: the sixth asks again", () => {
    const ledger = new SendLedger();
    for (let i = 0; i < 4; i++) ledger.record(MARIA, T0 + i * MIN);
    expect(ledger.check(MARIA, T0 + 5 * MIN)).toEqual({});
    ledger.record(MARIA, T0 + 5 * MIN);
    const sixth = ledger.check(MARIA, T0 + 6 * MIN);
    expect(sixth.ask).toContain("5 texts");
    expect(sixth.refuse).toBeUndefined();
  });

  test("ten texts to one person in 10 minutes: the next is refused", () => {
    const ledger = new SendLedger();
    for (let i = 0; i < 10; i++) ledger.record(MARIA, T0 + i * 30_000);
    const next = ledger.check(MARIA, T0 + 5 * MIN + 30_000);
    expect(next.refuse).toContain("10 texts");
  });

  test("texts to others don't count toward one person's limit", () => {
    const ledger = new SendLedger();
    for (let i = 0; i < 5; i++) ledger.record(`+3069000000${i}`, T0 + i * 1000);
    expect(ledger.check(MARIA, T0 + 10_000)).toEqual({});
  });

  test("texts to anyone count toward the hourly limits of 20 and 40", () => {
    const ledger = new SendLedger();
    // Two texts to each of ten people, five minutes apart: never more than 5 to one person in 10 minutes.
    for (let i = 0; i < 20; i++) ledger.record(`+30690000${String(i % 10).padStart(4, "0")}`, T0 + i * 2 * MIN);
    const asked = ledger.check(MARIA, T0 + 40 * MIN);
    expect(asked.ask).toContain("20 texts");
    expect(asked.refuse).toBeUndefined();
    for (let i = 0; i < 20; i++) ledger.record(`+30691000${String(i % 10).padStart(4, "0")}`, T0 + 40 * MIN + i * 30_000);
    expect(ledger.check(MARIA, T0 + 55 * MIN).refuse).toContain("40 texts");
  });

  test("old sends age out of both windows", () => {
    const ledger = new SendLedger();
    for (let i = 0; i < 10; i++) ledger.record(MARIA, T0 + i * 1000);
    expect(ledger.check(MARIA, T0 + 10 * MIN + 10_000)).toEqual({});
    for (let i = 0; i < 30; i++) ledger.record(`+3069000${String(i).padStart(5, "0")}`, T0 + i * 1000);
    expect(ledger.check(MARIA, T0 + 61 * MIN)).toEqual({});
  });

  test("tryReserve counts a send only when the hard limits allow it", () => {
    const ledger = new SendLedger();
    for (let i = 0; i < 9; i++) ledger.record(MARIA, T0 + i * 1000);
    expect(ledger.tryReserve(MARIA, T0 + 10_000)).toEqual({});
    expect(ledger.tryReserve(MARIA, T0 + 11_000).refuse).toContain("10 texts");
    // The refused attempt wasn't counted: still 10.
    expect(ledger.check(MARIA, T0 + 12_000).refuse).toContain("10 texts");
    expect(ledger.tryReserve("+306900000001", T0 + 12_000)).toEqual({});
  });

  test("a recipient is matched by its target string, the same one the permission rule uses", () => {
    const ledger = new SendLedger();
    for (let i = 0; i < 5; i++) ledger.record("chat:iMessage;+;chat1", T0 + i * 1000);
    expect(ledger.check("chat:iMessage;+;chat1", T0 + 10_000).ask).toBeDefined();
    expect(ledger.check(MARIA, T0 + 10_000)).toEqual({});
  });
});
