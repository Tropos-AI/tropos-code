// test/install/helpers/engine.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withInstallLock, type EngineDeps } from "../../../src/install/engine";
import { ensureLayout, resolveLayout, type Layout } from "../../../src/install/layout";
import { switchLink } from "../../../src/install/link";
import { detectPlatform } from "../../../src/install/platform";
import type { RecoveryReport } from "../../../src/install/recovery";
import { emptyState, readState, writeState, type InstallState } from "../../../src/install/state";
import { defaultHealthCheck } from "../../../src/install/verify";
import { makeTmpDir, removeDir } from "../../helpers/tmp";
import { installDirect, makeFixtureRelease, publishFixture, type FixtureRelease } from "./fixture-release";
import { makeTestKey, type TestKey } from "./keys";
import { startReleaseServer, type ReleaseServer } from "./release-server";

export interface EngineFixture {
  root: string;
  home: string;
  layout: Layout;
  key: TestKey;
  srv: ReleaseServer;
  deps: EngineDeps;
  release(version: string, binary?: string): Promise<FixtureRelease>;
  direct(version: string): Promise<void>;
  setup(opts: { versions: string[]; current?: string; previous?: string; link?: string }): Promise<void>;
  state(): Promise<InstallState>;
  recoverNow(): Promise<RecoveryReport>;
  close(): Promise<void>;
}

export async function makeEngineFixture(extra: Partial<EngineDeps> = {}): Promise<EngineFixture> {
  const root = await makeTmpDir();
  const home = join(root, "home dir");
  await mkdir(home);
  const key = await makeTestKey(root, "release");
  const srv = startReleaseServer();
  const layout = resolveLayout({ HOME: home });
  await ensureLayout(layout);
  const deps: EngineDeps = {
    layout,
    platform: detectPlatform(),
    trusted: key.trusted,
    urls: srv.urls,
    allowLoopbackHttp: true,
    health: (bin, v) => defaultHealthCheck(bin, v),
    selfVersion: "test",
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    lockTimeoutMs: 5000,
    ...extra,
  };
  const releases = new Map<string, FixtureRelease>();
  const release = async (version: string, binary?: string) => {
    let r = releases.get(version);
    if (!r || binary) {
      r = await makeFixtureRelease({ version, key, dir: root, binary });
      releases.set(version, r);
      publishFixture(srv, r);
    }
    return r;
  };
  return {
    root,
    home,
    layout,
    key,
    srv,
    deps,
    release,
    direct: async (v) => installDirect(layout, await release(v)),
    async setup({ versions, current, previous, link }) {
      for (const v of versions) await installDirect(layout, await release(v));
      if (link) await switchLink(layout, link);
      await writeState(layout, { ...emptyState(), current: current ?? null, previous: previous ?? null });
    },
    async state() {
      const r = await readState(layout);
      if (r.kind !== "ok") throw new Error(`install state is ${r.kind}`);
      return r.state;
    },
    recoverNow: async () => (await withInstallLock(deps, { wait: true }, async () => undefined))!.recovery,
    async close() {
      srv.stop();
      await removeDir(root);
    },
  };
}
