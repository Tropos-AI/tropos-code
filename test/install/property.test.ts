// test/install/property.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, lstat, rm, symlink, truncate, writeFile } from "node:fs/promises";
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

describe("recovery never activates an unverified binary", () => {
  for (let seed = 1; seed <= 40; seed++) {
    test(`seed ${seed}`, async () => {
      const random = rng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
      f = await makeEngineFixture();
      await f.setup({ versions: VERSIONS, current: "1.2.0", previous: "1.1.0", link: "1.2.0" });
      const decoy = join(f.root, "decoy");
      await writeFile(decoy, "decoy bytes");
      /** lstat that maps only ENOENT to null; anything else fails the test. */
      const stat = async (path: string) => {
        try {
          return await lstat(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw e;
        }
      };
      /** Remove a path; effective only if something was there. */
      const remove = async (path: string) => {
        const existed = (await stat(path)) !== null;
        await rm(path, { force: true });
        return existed;
      };
      /** Modify a regular version binary in place; a symlink or missing path is skipped (never write through). */
      const edit = async (v: string, op: (path: string) => Promise<void>) => {
        const path = versionPath(f.layout, v);
        const st = await stat(path);
        if (!st || !st.isFile()) return false;
        await chmod(path, 0o755); // installed binaries are read-only
        await op(path);
        return true;
      };
      // Each mutation reports whether it actually changed anything.
      const mutations: Array<(v: string) => Promise<boolean>> = [
        (v) => edit(v, (path) => truncate(path, 10)),
        (v) => edit(v, (path) => appendFile(path, "x")),
        (v) => remove(versionPath(f.layout, v)),
        async (v) => {
          await rm(versionPath(f.layout, v), { force: true });
          await symlink(decoy, versionPath(f.layout, v));
          return true;
        },
        async (v) => {
          await appendFile(join(manifestDir(f.layout, v), "manifest.json"), " ");
          return true;
        },
        (v) => remove(join(manifestDir(f.layout, v), "manifest.json.sig")),
        () => remove(f.layout.binLink),
        async () => {
          await rm(f.layout.binLink, { force: true });
          await symlink(versionPath(f.layout, pick([...VERSIONS, "9.9.9"])), f.layout.binLink);
          return true;
        },
        () => remove(f.layout.stateFile),
        async () => {
          await writeFile(f.layout.stateFile, "garbage");
          return true;
        },
        async () => {
          await writeState(f.layout, { ...emptyState(), current: pick([...VERSIONS, "9.9.9"]), previous: pick(VERSIONS) });
          return true;
        },
        async () => {
          await writeState(f.layout, { ...emptyState(), current: "1.2.0", pending: { op: "switch", from: pick([null, ...VERSIONS]), to: pick(VERSIONS) } });
          return true;
        },
      ];
      const count = 1 + Math.floor(random() * 4);
      let effective = 0;
      // Apply `count` mutations, then keep re-picking (same PRNG, so still deterministic) until one took effect.
      for (let i = 0; i < count || (effective === 0 && i < 200); i++) {
        if (await pick(mutations)(pick(VERSIONS))) effective++;
      }
      expect(effective).toBeGreaterThan(0);
      await f.recoverNow();
      const link = await readLink(f.layout);
      expect(link.kind === "missing" || link.kind === "ours").toBe(true);
      if (link.kind === "ours") expect(await checkHealthy(verifyContext(f.deps), link.version)).toEqual({ ok: true });
    });
  }
});
