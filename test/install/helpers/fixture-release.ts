// test/install/helpers/fixture-release.ts
// Fake releases: a shell-script "binary" that answers --version like tcode, signed with a test key.
import { chmod, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { versionPath, type Layout } from "../../../src/install/layout";
import { serializeManifest, verifyManifest, type Manifest, type VerifiedManifest } from "../../../src/install/manifest";
import { PLATFORMS } from "../../../src/install/platform";
import { storeManifest } from "../../../src/install/verify";
import { sshSign, type TestKey } from "./keys";
import type { ReleaseServer } from "./release-server";
import { sha256Hex } from "./zstd-corpus";

export function fakeBinary(version: string, extra = ""): string {
  return `#!/bin/sh\n${extra}\nif [ "$1" = "--version" ]; then echo "${version} (Tropos Code)"; exit 0; fi\necho "fake tcode ${version} $*"\n`;
}

export interface FixtureRelease {
  version: string;
  binary: Uint8Array;
  zst: Uint8Array;
  verified: VerifiedManifest;
}

export async function makeFixtureRelease(opts: { version: string; key: TestKey; dir: string; binary?: Uint8Array | string; zst?: Uint8Array }): Promise<FixtureRelease> {
  const binary = typeof opts.binary === "string" ? new TextEncoder().encode(opts.binary) : (opts.binary ?? new TextEncoder().encode(fakeBinary(opts.version)));
  const zst = opts.zst ?? Bun.zstdCompressSync(binary);
  const [binarySha, zstSha] = [sha256Hex(binary), sha256Hex(zst)]; // once, not per platform: a real binary is ~70 MB
  const entry = (p: string) => ({ asset: `tropos-${p}`, sha256: binarySha, size: binary.length, zst: { asset: `tropos-${p}.zst`, sha256: zstSha, size: zst.length } });
  const manifest = { schema: 1, version: opts.version, commit: "f".repeat(40), buildDate: "2026-10-13T00:00:00Z", platforms: Object.fromEntries(PLATFORMS.map((p) => [p, entry(p)])) } as Manifest;
  const bytes = new TextEncoder().encode(serializeManifest(manifest));
  const signature = await sshSign(opts.key, bytes, "tropos-manifest", opts.dir);
  return { version: opts.version, binary, zst, verified: verifyManifest(bytes, signature, opts.key.trusted) };
}

export function publishFixture(srv: ReleaseServer, r: FixtureRelease): void {
  const tag = `v${r.version}`;
  srv.put(tag, "manifest.json", r.verified.bytes);
  srv.put(tag, "manifest.json.sig", r.verified.signature);
  for (const p of PLATFORMS) {
    srv.put(tag, `tropos-${p}`, r.binary);
    srv.put(tag, `tropos-${p}.zst`, r.zst);
  }
}

/** Puts a release straight into versions/ with its stored manifest, as a completed install would. */
export async function installDirect(l: Layout, r: FixtureRelease): Promise<void> {
  const tmp = join(l.staging, `direct-${r.version}`);
  await writeFile(tmp, r.binary);
  await chmod(tmp, 0o755);
  await storeManifest(l, r.version, r.verified);
  await copyFile(tmp, versionPath(l, r.version));
  await chmod(versionPath(l, r.version), 0o755);
}
