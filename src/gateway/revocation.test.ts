import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { WebHost } from "../web/host";
import { SessionPool } from "./pool";
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

test("a demoted owner's session closes without a final review: it would still run with owner powers", async () => {
  const dir = await makeTmpDir("reaper");
  try {
    const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>();
    const pool = new SessionPool({
      statePath: join(dir, "sessions.json"),
      idleMs: 60_000,
      sweepEveryMs: 0,
      create: async (key) => {
        const runtime = fakeRuntime([]);
        runtimes.set(key, runtime);
        return { host: new WebHost(runtime), sessionId: () => key, close: async () => {} };
      },
    });
    await pool.open("telegram:1@a");
    const asked: Array<{ key: string; opts: unknown }> = [];
    await reapRevoked({
      sessionKeys: () => pool.keys(),
      closeSession: (k, opts) => (asked.push({ key: k, opts }), pool.close(k, opts)),
      isApproved: async () => true,
      isOwner: async () => false,
      roleOf: () => "owner",
      cron: { list: () => [] as never, setEnabled: () => undefined as never },
    });
    expect(asked).toEqual([{ key: "telegram:1@a", opts: { finalReview: false } }]);
    expect(runtimes.get("telegram:1@a")!.shutdowns).toEqual([{ finalReview: false }]);
    expect(pool.keys()).toEqual([]);
  } finally {
    await removeDir(dir);
  }
});

test("a pairing check that throws for one key is logged and skipped; the rest of the pass still runs", async () => {
  const closed: string[] = [];
  const disabled: string[] = [];
  const logged: string[] = [];
  const out = await reapRevoked({
    sessionKeys: () => ["telegram:1@default", "telegram:2@default", "telegram:3@default"],
    closeSession: async (k) => void closed.push(k),
    isApproved: async (_c, s) => {
      if (s === "1") throw new Error("pairing file busy");
      return s === "3";
    },
    isOwner: async () => {
      throw new Error("owner lookup failed");
    },
    roleOf: (k) => (k === "telegram:3@default" ? "owner" : "guest"),
    cron: {
      list: () => [job("a", "telegram:1"), job("b", "telegram:2")] as never,
      setEnabled: (id) => void disabled.push(id) as never,
    },
    log: (m) => logged.push(m),
  });
  expect(closed).toEqual(["telegram:2@default"]);
  expect(disabled).toEqual(["b"]);
  expect(out).toEqual({ sessions: ["telegram:2@default"], jobs: ["b"] });
  expect(logged).toEqual([
    "couldn't check telegram:1@default: pairing file busy",
    "couldn't check telegram:3@default: owner lookup failed",
    "couldn't check job a: pairing file busy",
  ]);
});
