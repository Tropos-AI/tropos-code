import { expect, test } from "bun:test";
import { reapRevoked } from "./revocation";

const job = (id: string, deliver: string, enabled = true) => ({ id, deliver, enabled });

test("closes sessions and disables jobs of unapproved private Telegram senders only", async () => {
  const closed: string[] = [];
  const disabled: string[] = [];
  const out = await reapRevoked({
    sessionKeys: () => ["telegram:1@default", "telegram:2@default", "telegram:-100@default", "project:x@x"],
    closeSession: async (k) => void closed.push(k),
    isApproved: async (_c, s) => s === "1",
    isOwner: async () => false,
    roleOf: () => "guest",
    cron: {
      list: () => [job("a", "telegram:1"), job("b", "telegram:2"), job("c", "telegram:2", false), job("d", "none")] as never,
      setEnabled: (id) => void disabled.push(id) as never,
    },
  });
  expect(closed).toEqual(["telegram:2@default"]);
  expect(disabled).toEqual(["b"]);
  expect(out).toEqual({ sessions: ["telegram:2@default"], jobs: ["b"] });
});

test("a session opened as owner is closed once its sender is no longer the owner; a guest session of the same sender stays", async () => {
  const closed: string[] = [];
  const roles: Record<string, "owner" | "guest"> = { "telegram:1@a": "owner", "telegram:1@b": "guest" };
  await reapRevoked({
    sessionKeys: () => Object.keys(roles),
    closeSession: async (k) => void closed.push(k),
    isApproved: async () => true,
    isOwner: async () => false,
    roleOf: (k) => roles[k],
    cron: { list: () => [] as never, setEnabled: () => undefined as never },
  });
  expect(closed).toEqual(["telegram:1@a"]);
});
