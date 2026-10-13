// test/install/property.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyContext } from "../../src/install/engine";
import { manifestDir, versionPath } from "../../src/install/layout";
import { readLink } from "../../src/install/link";
import { emptyState, writeState } from "../../src/install/state";
import { checkHealthy } from "../../src/install/verify";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

/** mulberry32: small deterministic PRNG so every failure is reproducible from its seed. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERSIONS = ["1.0.0", "1.1.0", "1.2.0"];

describe("recovery never activates an unverified binary (R6.4)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    test(`seed ${seed}`, async () => {
      const random = rng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
      f = await makeEngineFixture();
      await f.setup({ versions: VERSIONS, current: "1.2.0", previous: "1.1.0", link: "1.2.0" });
      const mutations = [
        async (v: string) => {
          await chmod(versionPath(f.layout, v), 0o755).catch(() => undefined); // installed binaries are read-only
          await truncate(versionPath(f.layout, v), 10).catch(() => undefined);
        },
        async (v: string) => {
          await chmod(versionPath(f.layout, v), 0o755).catch(() => undefined);
          await appendFile(versionPath(f.layout, v), "x").catch(() => undefined);
        },
        async (v: string) => rm(versionPath(f.layout, v), { force: true }),
        async (v: string) => {
          await rm(versionPath(f.layout, v), { force: true });
          await symlink("/bin/sh", versionPath(f.layout, v));
        },
        async (v: string) => appendFile(join(manifestDir(f.layout, v), "manifest.json"), " "),
        async (v: string) => rm(join(manifestDir(f.layout, v), "manifest.json.sig"), { force: true }),
        async () => rm(f.layout.binLink, { force: true }),
        async () => {
          await rm(f.layout.binLink, { force: true });
          await symlink(versionPath(f.layout, pick([...VERSIONS, "9.9.9"])), f.layout.binLink);
        },
        async () => rm(f.layout.stateFile, { force: true }),
        async () => writeFile(f.layout.stateFile, "garbage"),
        async () => writeState(f.layout, { ...emptyState(), current: pick([...VERSIONS, "9.9.9"]), previous: pick(VERSIONS) }),
        async () => writeState(f.layout, { ...emptyState(), current: "1.2.0", pending: { op: "switch", from: pick([null, ...VERSIONS]), to: pick(VERSIONS) } }),
      ];
      const count = 1 + Math.floor(random() * 4);
      for (let i = 0; i < count; i++) await pick(mutations)(pick(VERSIONS));
      await f.recoverNow();
      const link = await readLink(f.layout);
      expect(link.kind === "missing" || link.kind === "ours").toBe(true);
      if (link.kind === "ours") expect(await checkHealthy(verifyContext(f.deps), link.version)).toEqual({ ok: true });
    });
  }
});
