import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePairing, ownerChatKey } from "./pairing";

const HOUR = 3_600_000;
const ALPHABET = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

let dir: string;
let path: string;
let t: number;
let seed: number;

/** Deterministic, non-repeating byte source. */
function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out[i] = seed >>> 16;
  }
  return out;
}

function make(): FilePairing {
  return new FilePairing({ path, now: () => t, random });
}

async function codeOf(p: FilePairing, sender = "u1", channel = "telegram"): Promise<string> {
  const c = await p.challenge(channel, sender);
  if (c.kind !== "code") throw new Error("expected a code");
  return c.code;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pairing-"));
  path = join(dir, "gateway", "pairing.json");
  t = 1_000_000;
  seed = 42;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("FilePairing", () => {
  test("denies everyone by default", async () => {
    const p = make();
    expect(await p.isApproved("telegram", "u1")).toBe(false);
    expect(await p.list()).toEqual([]);
  });

  test("issues an 8 character code from the unambiguous alphabet, valid one hour", async () => {
    const p = make();
    const c = await p.challenge("telegram", "u1");
    expect(c.kind).toBe("code");
    if (c.kind !== "code") return;
    expect(c.code).toMatch(ALPHABET);
    expect(c.expiresAt).toBe(t + HOUR);
    for (let i = 0; i < 50; i++) expect(await codeOf(p, `s${i}`)).toMatch(ALPHABET);
  });

  test("returns the same code while valid, a new one after expiry", async () => {
    const p = make();
    const a = await codeOf(p);
    t += HOUR - 1;
    expect(await codeOf(p)).toBe(a);
    t += 2;
    const b = await codeOf(p);
    expect(b).not.toBe(a);
    expect(await p.approve("telegram", a)).toMatchObject({ ok: false });
    expect(await p.approve("telegram", b)).toEqual({ ok: true, senderId: "u1" });
  });

  test("a restarted instance cannot re-show a code, so it issues a replacement that supersedes the old one", async () => {
    const a = await codeOf(make());
    const p2 = make();
    const b = await codeOf(p2);
    expect(b).not.toBe(a);
    expect(await p2.approve("telegram", a)).toMatchObject({ ok: false });
    expect(await p2.approve("telegram", b)).toMatchObject({ ok: true });
  });

  test("approve consumes the code and records the sender", async () => {
    const p = make();
    const code = await codeOf(p);
    t += 5;
    expect(await p.approve("telegram", code.toLowerCase())).toEqual({ ok: true, senderId: "u1" });
    expect(await p.isApproved("telegram", "u1")).toBe(true);
    expect(await p.isApproved("slack", "u1")).toBe(false);
    expect(await p.list()).toEqual([{ channel: "telegram", senderId: "u1", approvedAt: t }]);
    expect(await p.approve("telegram", code)).toMatchObject({ ok: false });
  });

  test("a code only works on its own channel", async () => {
    const p = make();
    const code = await codeOf(p, "u1", "telegram");
    expect(await p.approve("slack", code)).toMatchObject({ ok: false });
    expect(await p.isApproved("telegram", "u1")).toBe(false);
  });

  test("approved senders get no new code (challenge throws)", async () => {
    const p = make();
    await p.approve("telegram", await codeOf(p));
    await expect(p.challenge("telegram", "u1")).rejects.toThrow(/already approved/);
  });

  test("rate limit: five codes per rolling hour, then limited", async () => {
    const p = make();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      seen.add(await codeOf(p));
      // revoking drops the pending code, so the next call issues a fresh one within the same rolling hour
      await p.revoke("telegram", "u1");
    }
    expect(seen.size).toBe(5);
    expect(await p.challenge("telegram", "u1")).toEqual({ kind: "limited" });
    // other senders are unaffected
    expect((await p.challenge("telegram", "u2")).kind).toBe("code");
    // the window rolls
    t += HOUR + 1;
    expect((await p.challenge("telegram", "u1")).kind).toBe("code");
  });

  test("lockout: five failed approvals lock the channel for the rest of the hour", async () => {
    const p = make();
    const code = await codeOf(p);
    for (let i = 0; i < 5; i++) {
      t += 1000;
      expect(await p.approve("telegram", "AAAAAAAA")).toMatchObject({ ok: false });
    }
    const locked = await p.approve("telegram", code);
    expect(locked).toMatchObject({ ok: false });
    expect((locked as { reason: string }).reason).toMatch(/try again later/i);
    expect(await p.isApproved("telegram", "u1")).toBe(false);
    // another channel is not locked
    expect(await p.approve("slack", "AAAAAAAA")).not.toMatchObject({ reason: expect.stringMatching(/try again later/i) });
    t += HOUR;
    expect(await p.approve("telegram", code)).toMatchObject({ ok: false }); // expired by now
    const fresh = await codeOf(p);
    expect(await p.approve("telegram", fresh)).toMatchObject({ ok: true });
  });

  test("failures older than an hour do not count", async () => {
    const p = make();
    for (let i = 0; i < 4; i++) await p.approve("telegram", "AAAAAAAA");
    t += HOUR + 1;
    for (let i = 0; i < 4; i++) await p.approve("telegram", "AAAAAAAA");
    const code = await codeOf(p);
    expect(await p.approve("telegram", code)).toMatchObject({ ok: true });
  });

  test("expired codes are rejected with an expiry reason", async () => {
    const p = make();
    const code = await codeOf(p);
    t += HOUR + 1;
    const r = await p.approve("telegram", code);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/expired/i);
  });

  test("the file never contains a code, only hashes", async () => {
    const p = make();
    const code = await codeOf(p);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(code.toLowerCase());
    expect(JSON.parse(raw).salt).toMatch(/^[0-9a-f]{32,}$/);
    await p.approve("telegram", code);
    expect(await readFile(path, "utf8")).not.toContain(code);
  });

  test("file is 0600 and directory 0700", async () => {
    const p = make();
    await codeOf(p);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "gateway"))).mode & 0o777).toBe(0o700);
  });

  test("a missing or corrupt file starts empty and never throws on read", async () => {
    const p = make();
    expect(await p.list()).toEqual([]);
    await mkdir(join(dir, "gateway"), { recursive: true });
    for (const junk of ["{not json", "[]", "null", '{"approved":"x","pending":5}', ""]) {
      await writeFile(path, junk);
      expect(await p.isApproved("telegram", "u1")).toBe(false);
      expect(await p.list()).toEqual([]);
    }
    await writeFile(path, "{not json");
    const code = await codeOf(p);
    expect(await p.approve("telegram", code)).toMatchObject({ ok: true });
  });

  test("concurrent calls on one instance are serialised", async () => {
    const p = make();
    const codes = await Promise.all(Array.from({ length: 20 }, (_, i) => codeOf(p, `u${i}`)));
    expect(new Set(codes).size).toBe(20);
    const results = await Promise.all(codes.map((c) => p.approve("telegram", c)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await p.list()).length).toBe(20);
  });

  test("two instances on one file see each other's writes", async () => {
    const a = make();
    const b = make();
    const [ca, cb] = [await codeOf(a, "ua"), await codeOf(b, "ub")];
    expect(await b.approve("telegram", ca)).toEqual({ ok: true, senderId: "ua" });
    expect(await a.approve("telegram", cb)).toEqual({ ok: true, senderId: "ub" });
    expect(await a.isApproved("telegram", "ub")).toBe(true);
    expect((await b.list()).map((s) => s.senderId).sort()).toEqual(["ua", "ub"]);
  });

  test("revoke removes approval and pending codes", async () => {
    const p = make();
    await p.approve("telegram", await codeOf(p, "u1"));
    const pending = await codeOf(p, "u2");
    expect(await p.revoke("telegram", "u1")).toBe(true);
    expect(await p.revoke("telegram", "u1")).toBe(false);
    expect(await p.isApproved("telegram", "u1")).toBe(false);
    expect(await p.revoke("telegram", "u2")).toBe(true); // had a pending code
    expect(await p.approve("telegram", pending)).toMatchObject({ ok: false });
  });

  test("pending lists unexpired requests without the code or the sender", async () => {
    const p = make();
    const code = await codeOf(p, "u1");
    const listed = await p.pending();
    expect(listed).toEqual([{ channel: "telegram", requestedAt: t, expiresAt: t + HOUR }]);
    expect(JSON.stringify(listed)).not.toContain(code);
    expect(JSON.stringify(listed)).not.toContain("u1");
    t += HOUR + 1;
    expect(await p.pending()).toEqual([]);
    await p.approve("telegram", await codeOf(p, "u2"));
    expect(await p.pending()).toEqual([]);
  });
});

describe("owner", () => {
  const v1 = (approved: { channel: string; senderId: string; approvedAt: number }[]) =>
    mkdir(join(dir, "gateway"), { recursive: true }).then(() =>
      writeFile(path, JSON.stringify({ version: 1, salt: "0123456789abcdef0123456789abcdef", approved, pending: [], issued: [], failures: [] })),
    );
  const approvedAt = (senderId: string) => ({ channel: "telegram", senderId, approvedAt: 1 });
  const approveNew = async (p: FilePairing, sender: string) => {
    const r = await p.approve("telegram", await codeOf(p, sender));
    if (!r.ok) throw new Error(r.reason);
  };

  test("a version-1 file with exactly one approved sender gets that sender as owner, written back once", async () => {
    await v1([approvedAt("7")]);
    const p = new FilePairing({ path, now: () => t, random });
    expect(await p.isApproved("telegram", "7")).toBe(true); // a read-only call still migrates
    const file = JSON.parse(await readFile(path, "utf8"));
    expect(file.version).toBe(2);
    expect(file.owner).toMatchObject({ channel: "telegram", senderId: "7" });
    expect(typeof file.owner.since).toBe("number");
  });

  test("a version-1 file with two approved senders gets no owner", async () => {
    await v1([approvedAt("7"), approvedAt("8")]);
    const p = make();
    expect(await p.owner()).toBeNull();
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
  });

  test("revoking the owner clears it and the remaining single sender is not promoted", async () => {
    await v1([approvedAt("7"), approvedAt("8")]);
    const p = make();
    await p.setOwner("telegram", "7");
    expect(await p.revoke("telegram", "7")).toBe(true);
    expect(await make().owner()).toBeNull();
    expect(await make().isApproved("telegram", "8")).toBe(true);
  });

  test("the first approval on a fresh store becomes the owner; the second doesn't", async () => {
    const p = make();
    expect(await p.owner()).toBeNull();
    await approveNew(p, "u1");
    expect(await p.owner()).toMatchObject({ channel: "telegram", senderId: "u1" });
    await approveNew(p, "u2");
    expect(await p.owner()).toMatchObject({ senderId: "u1" });
  });

  test("setOwner refuses a sender that isn't approved and switches between approved ones", async () => {
    const p = make();
    await approveNew(p, "u1");
    await approveNew(p, "u2");
    await expect(p.setOwner("telegram", "nobody")).rejects.toThrow("only an approved sender can be the owner");
    await p.setOwner("telegram", "u2");
    expect(await p.owner()).toMatchObject({ senderId: "u2" });
    expect(await p.isOwner("telegram", "u2")).toBe(true);
    expect(await p.isOwner("telegram", "u1")).toBe(false);
  });

  test("isOwner is false for another channel with the same sender id", async () => {
    const p = make();
    await approveNew(p, "u1");
    expect(await p.isOwner("telegram", "u1")).toBe(true);
    expect(await p.isOwner("slack", "u1")).toBe(false);
  });

  test("ownerChatKey is telegram:<id> or undefined", async () => {
    const p = make();
    expect(await ownerChatKey(p)).toBeUndefined();
    await approveNew(p, "u1");
    expect(await ownerChatKey(p)).toBe("telegram:u1");
  });
});
