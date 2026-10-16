import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { GOOD_KEY, fakeNet, testDeps } from "../../onboard/testing";
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
});
