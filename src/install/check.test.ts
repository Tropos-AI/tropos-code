// src/install/check.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { startReleaseServer, type ReleaseServer } from "../../test/install/helpers/release-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { checkForUpdate } from "./check";
import { ensureLayout, resolveLayout } from "./layout";
import { emptyState, readState, writeState } from "./state";

let dir: string;
let srv: ReleaseServer;
beforeEach(async () => {
  dir = await makeTmpDir();
  srv = startReleaseServer();
});
afterEach(async () => {
  srv.stop();
  await removeDir(dir);
});

const deps = (layout: ReturnType<typeof resolveLayout>) => ({ urls: srv.urls, trusted: [], layout, selfVersion: "1.0.0", sleep: async () => {}, random: () => 0.5, allowLoopbackHttp: true, now: () => new Date("2026-10-15T12:00:00Z") });

test("reports the channel's version and records only lastCheck", async () => {
  const layout = resolveLayout({ HOME: dir }, dir);
  await ensureLayout(layout);
  await writeState(layout, { ...emptyState(), current: "1.0.0", autoUpdate: { ...emptyState().autoUpdate, nextCheck: "2026-10-16T00:00:00.000Z" } });
  srv.put("channels", "latest", "1.1.0\n");
  const r = await checkForUpdate(deps(layout), "latest", "1.0.0");
  expect(r).toMatchObject({ channel: "latest", latest: "1.1.0", source: "primary", available: true, checkedAt: "2026-10-15T12:00:00.000Z" });
  const read = await readState(layout);
  expect(read.kind === "ok" && read.state.autoUpdate).toMatchObject({ lastCheck: "2026-10-15T12:00:00.000Z", nextCheck: "2026-10-16T00:00:00.000Z" });
  expect((await checkForUpdate(deps(layout), "latest", "1.1.0")).available).toBe(false);
});

test("still answers when there is no install state, and fails when the channel is unreachable", async () => {
  const layout = resolveLayout({ HOME: dir }, dir);
  srv.put("channels", "stable", "2.0.0\n");
  expect((await checkForUpdate(deps(layout), "stable", "1.0.0")).latest).toBe("2.0.0");
  srv.stop();
  await expect(checkForUpdate(deps(layout), "latest", "1.0.0")).rejects.toThrow();
});
