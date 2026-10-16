import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FilePairing } from "../../gateway/pairing";
import { adminWith, failure, makeKit, type Kit } from "./host-testkit";
import { pairingHandlers } from "./pairing";

let kit: Kit;
let t: number;
let store: FilePairing;
beforeEach(async () => {
  kit = await makeKit();
  t = 1_000_000;
  store = new FilePairing({ path: join(kit.home, "gateway", "pairing.json"), now: () => t });
});
afterEach(() => kit.close());
const admin = () => adminWith(kit, pairingHandlers(kit.ctx, { pairing: store }));
const code = async (sender: string) => {
  const c = await store.challenge("telegram", sender);
  if (c.kind !== "code") throw new Error("no code");
  return c.code;
};

test("pairing.list shows approved senders and pending requests without codes or senders", async () => {
  const c1 = await code("u1");
  await store.approve("telegram", c1);
  const c2 = await code("u2");
  const view = (await admin().handle("pairing.list", undefined)) as any;
  expect(view.approved).toEqual([{ channel: "telegram", senderId: "u1", approvedAt: t }]);
  expect(view.pending).toEqual([{ channel: "telegram", requestedAt: t, expiresAt: t + 3_600_000 }]);
  expect(JSON.stringify(view)).not.toContain(c2);
  expect(JSON.stringify(view.pending)).not.toContain("u2");
});

test("approve takes the code, shows the engine's reason when refused, and the rate limit applies", async () => {
  const a = admin();
  expect(await failure(a, "pairing.approve", { channel: "telegram", code: "WRONGCODE" })).toBe("Unknown code.");
  expect(await a.handle("pairing.approve", { channel: "telegram", code: ` ${await code("u9")} ` })).toEqual({ senderId: "u9" });
  for (let i = 0; i < 5; i++) await failure(a, "pairing.approve", { channel: "telegram", code: `BAD${i}BAD${i}` });
  expect(await failure(a, "pairing.approve", { channel: "telegram", code: "ANYTHING" })).toContain("Too many failed attempts");
  expect(await failure(a, "pairing.approve", { channel: "", code: "x" })).toContain("channel");
});

test("revoke removes an approved sender", async () => {
  await store.approve("telegram", await code("u1"));
  const a = admin();
  expect(await a.handle("pairing.revoke", { channel: "telegram", senderId: "u1" })).toEqual({ removed: true });
  expect(await a.handle("pairing.revoke", { channel: "telegram", senderId: "u1" })).toEqual({ removed: false });
});
