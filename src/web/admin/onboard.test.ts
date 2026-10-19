import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { loadIdentity } from "../../context/identity";
import { OwnerClaimStore } from "../../gateway/owner-claim";
import { FilePairing } from "../../gateway/pairing";
import { GOOD_KEY, fakeNet, fakeTailscale, testDeps } from "../../onboard/testing";
import type { AdminMethod, AdminParams, AdminResult } from "./api";
import { createAdmin, type AdminContext } from "./index";
import { onboardHandlers } from "./onboard";

let root: string;
let home: string;
beforeEach(async () => {
  root = await makeTmpDir("admin-onboard-");
  home = join(root, ".tropos");
  await mkdir(home, { recursive: true });
});
afterEach(() => removeDir(root));

const ctxFor = (): AdminContext => ({ home, userHome: root, env: { PATH: "" }, version: "0", execPath: "/x/tcode", cwd: root, now: () => 0, fetch });

test("state, validateKey, finish and reopen work through the dispatcher's table", async () => {
  const net = fakeNet();
  const h = onboardHandlers(ctxFor(), testDeps(home, { fetch: net.fetch }));
  const admin = createAdmin(ctxFor(), h);
  const state = (await admin.handle("onboard.state", undefined)) as { complete: boolean; dismissed: boolean };
  expect(state).toMatchObject({ complete: false, dismissed: false });

  const bad = (await admin.handle("onboard.validateKey", { provider: "deepseek", key: "sk-nope-nope-nope" })) as { ok: boolean; error?: string };
  expect(bad.ok).toBe(false);
  expect(bad.error).not.toContain("sk-nope-nope-nope");

  const good = await admin.handle("onboard.validateKey", { provider: "deepseek", key: GOOD_KEY });
  expect(good).toEqual({ ok: true, models: ["deepseek-chat", "deepseek-reasoner"] });
  // validating must not save the key
  expect(await stat(join(home, "credentials.json")).catch(() => null)).toBeNull();

  expect(await admin.handle("onboard.finish", { skipped: ["telegram"] })).toMatchObject({ dismissed: true });
  expect(await admin.handle("onboard.finish", undefined)).toMatchObject({ dismissed: true });
  expect(await admin.handle("onboard.reopen", undefined)).toMatchObject({ dismissed: false });
});

test("bad parameters are refused with a plain message", async () => {
  const h = onboardHandlers(ctxFor(), testDeps(home));
  await expect(h["onboard.validateKey"]!({ provider: "", key: "x" })).rejects.toThrow("Choose a provider");
  await expect(h["onboard.validateKey"]!({ provider: "deepseek" } as never)).rejects.toThrow("Choose a provider");
  await expect(h["onboard.finish"]!({ skipped: ["nope"] } as never)).rejects.toThrow("Unknown step");
  await expect(h["onboard.finish"]!({ skipped: ["sandbox"] } as never)).rejects.toThrow("Unknown step");
});

// ---------- the guided steps ----------
/** `handle` with the method's own parameter and result types. */
function typedAdmin(ctx: AdminContext, handlers: ReturnType<typeof onboardHandlers>) {
  const admin = createAdmin(ctx, handlers);
  return { handle: <M extends AdminMethod>(method: M, params: AdminParams<M>) => admin.handle(method, params) as Promise<AdminResult<M>> };
}


function withGateway() {
  const gw = { reloads: 0 };
  const ctx: AdminContext = { ...ctxFor(), gateway: { reload: async () => void gw.reloads++, runCronNow: async () => {}, devicesChanged: async () => {} } };
  return { gw, ctx };
}
const stepStatus = (s: { steps: { id: string; status: string }[] }, id: string) => s.steps.find((x) => x.id === id)?.status;

test("start, skip and identity.save change the state; required steps can't be skipped", async () => {
  const admin = typedAdmin(ctxFor(), onboardHandlers(ctxFor(), testDeps(home)));
  expect(stepStatus(await admin.handle("onboard.start", undefined), "welcome")).toBe("done");
  expect(stepStatus(await admin.handle("onboard.skip", { id: "telegram" }), "telegram")).toBe("skipped");
  await expect(admin.handle("onboard.skip", { id: "model" })).rejects.toThrow("This step is needed");
  expect(stepStatus(await admin.handle("onboard.identity.save", { name: "Ada", emoji: "🦊" }), "identity")).toBe("done");
  expect((await loadIdentity(home)).name).toBe("Ada");
  await expect(admin.handle("onboard.identity.save", { name: "x".repeat(41) })).rejects.toThrow("at most 40");
  await expect(admin.handle("onboard.identity.save", { name: "Ada", emoji: "e".repeat(9) })).rejects.toThrow();
});

test("projects.scan finds repos under the user home and projects.add registers them", async () => {
  const repo = join(root, "Desktop", "shop");
  await mkdir(join(repo, ".git"), { recursive: true });
  const admin = typedAdmin(ctxFor(), onboardHandlers(ctxFor(), testDeps(home)));
  const scan = await admin.handle("onboard.projects.scan", undefined);
  expect(scan.repos.map((r) => r.path)).toContain(repo);
  const added = await admin.handle("onboard.projects.add", { paths: [repo, join(root, "nope")] });
  expect(added.added).toEqual([repo]);
  expect(added.failed.map((f) => f.path)).toEqual([join(root, "nope")]);
  await expect(admin.handle("onboard.projects.add", { paths: Array(51).fill(repo) })).rejects.toThrow();
});

test("autonomy.set refuses unconfined Balanced without confirmation, saves with it, and reloads the gateway", async () => {
  const { gw, ctx } = withGateway();
  const deps = testDeps(home, { confinement: async () => null });
  const admin = typedAdmin(ctx, onboardHandlers(ctx, deps));
  await expect(admin.handle("onboard.autonomy.set", { autonomy: "balanced" })).rejects.toThrow("Confirm");
  expect(gw.reloads).toBe(0);
  const saved = await admin.handle("onboard.autonomy.set", { autonomy: "balanced", acceptUnconfined: true });
  expect(saved).toMatchObject({ autonomy: "balanced", explicit: true, allowUnconfined: true });
  expect(gw.reloads).toBe(1);
  expect(await admin.handle("onboard.autonomy.get", undefined)).toMatchObject({ autonomy: "balanced" });
});

const cand = (senderId: string) => ({ senderId, chatId: Number(senderId), name: "Ada", at: Date.now() });
const pairingAt = (h: string) => new FilePairing({ path: join(h, "gateway", "pairing.json") });

test("telegram.listen needs the gateway and a token; confirm accepts only a waiting sender and makes them the owner", async () => {
  const noGateway = typedAdmin(ctxFor(), onboardHandlers(ctxFor(), testDeps(home, { fetch: fakeNet().fetch })));
  await expect(noGateway.handle("onboard.telegram.listen", undefined)).rejects.toThrow("Start Tropos in the background first");
  const { gw, ctx } = withGateway();
  const admin = typedAdmin(ctx, onboardHandlers(ctx, testDeps(home, { fetch: fakeNet().fetch })));
  await expect(admin.handle("onboard.telegram.listen", undefined)).rejects.toThrow("Add the bot token first");

  await Bun.write(join(home, "gateway.json"), JSON.stringify({ telegram: { botToken: "123:good" } }));
  const first = await admin.handle("onboard.telegram.listen", undefined);
  expect(first.candidates).toEqual([]);
  expect(first.bot).toBe("tropos_bot");
  const nonce = await new OwnerClaimStore(home).nonce();
  expect(first.link).toBe(`https://t.me/tropos_bot?start=${nonce}`);

  expect(await new OwnerClaimStore(home).add(cand("7"), nonce!)).toBe(true);
  const listed = await admin.handle("onboard.telegram.listen", undefined);
  expect(listed.candidates.map((c) => c.senderId)).toEqual(["7"]);
  expect(listed.link).toBe(first.link); // extends the same window

  await expect(admin.handle("onboard.telegram.confirm", { senderId: "9" })).rejects.toThrow("isn't waiting any more");
  await expect(admin.handle("onboard.telegram.confirm", { senderId: "7; drop" })).rejects.toThrow();
  expect(await pairingAt(home).owner()).toBeNull();
  expect(gw.reloads).toBe(0);
  const state = await admin.handle("onboard.telegram.confirm", { senderId: "7" });
  expect(stepStatus(state, "telegram")).toBe("done");
  expect(await pairingAt(home).owner()).toEqual({ channel: "telegram", senderId: "7" });
  expect(gw.reloads).toBe(1);
});

test("phone.enable returns url and code; summary answers", async () => {
  const { gw, ctx } = withGateway();
  const ts = fakeTailscale({ running: true, dnsName: "mac.tail1.ts.net" });
  const admin = typedAdmin(ctx, onboardHandlers(ctx, testDeps(home, { runner: { exec: ts.exec } })));
  expect(await admin.handle("onboard.phone.status", undefined)).toMatchObject({ installed: true, running: true, enabled: false });
  const on = await admin.handle("onboard.phone.enable", undefined);
  expect(on).toEqual({ url: expect.stringContaining("mac.tail1.ts.net"), code: "123456" });
  expect(gw.reloads).toBe(1);
  const off = typedAdmin(ctxFor(), onboardHandlers(ctxFor(), testDeps(home)));
  await expect(off.handle("onboard.phone.enable", undefined)).rejects.toThrow("Tailscale");
  const summary = await admin.handle("onboard.summary", undefined);
  expect(summary.dashboardUrl).toContain("127.0.0.1");
  expect(summary.steps.map((x) => x.id)).not.toContain("done");
});
