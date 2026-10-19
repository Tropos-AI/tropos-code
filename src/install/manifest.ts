// src/install/manifest.ts
import { z } from "zod";
import { InstallError } from "./errors";
import { PLATFORMS, type Platform } from "./platform";
import { verifySshSig, type TrustedKey } from "./sshsig";
import { NAMESPACE_MANIFEST, SIGNER_PRINCIPAL, TRUSTED_KEYS } from "./trust";
import { VERSION_RE } from "./version";

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_ASSET_SIZE = 1073741824;

export interface AssetEntry {
  asset: string;
  sha256: string;
  size: number;
}

export interface PlatformEntry extends AssetEntry {
  zst: AssetEntry;
}

export interface Manifest {
  schema: 1;
  version: string;
  commit: string;
  buildDate: string;
  platforms: Record<Platform, PlatformEntry>;
}

export interface VerifiedManifest {
  manifest: Manifest;
  bytes: Uint8Array;
  signature: string;
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const size = z.number().int().min(1).max(MAX_ASSET_SIZE);

function entrySchema(p: Platform) {
  return z
    .object({
      asset: z.literal(`tropos-${p}`),
      sha256,
      size,
      zst: z.object({ asset: z.literal(`tropos-${p}.zst`), sha256, size }).strict(),
    })
    .strict();
}

const manifestSchema = z
  .object({
    schema: z.literal(1),
    version: z.string().max(32).regex(VERSION_RE),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    buildDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/),
    platforms: z.object(Object.fromEntries(PLATFORMS.map((p) => [p, entrySchema(p)])) as Record<Platform, ReturnType<typeof entrySchema>>).strict(),
  })
  .strict();

const integrity = (message: string) => new InstallError("integrity", message);

/** The one canonical byte form: fixed key and platform order, two-space indent, LF, one final newline. */
export function serializeManifest(m: Manifest): string {
  const platforms: Record<string, unknown> = {};
  for (const p of PLATFORMS) {
    const e = m.platforms[p];
    platforms[p] = { asset: e.asset, sha256: e.sha256, size: e.size, zst: { asset: e.zst.asset, sha256: e.zst.sha256, size: e.zst.size } };
  }
  return `${JSON.stringify({ schema: m.schema, version: m.version, commit: m.commit, buildDate: m.buildDate, platforms }, null, 2)}\n`;
}

/** Strict parse: schema-valid AND byte-identical to its canonical serialisation (rejects duplicate keys, reordering, whitespace). */
export function parseManifest(bytes: Uint8Array): Manifest {
  if (bytes.length > MAX_MANIFEST_BYTES) throw integrity("manifest is too large");
  let text: string;
  try {
    // ignoreBOM keeps a BOM in the text, so JSON.parse rejects it instead of it being silently stripped.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw integrity("manifest is not UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw integrity("manifest is not JSON");
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw integrity(`manifest is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const manifest = parsed.data as Manifest;
  if (serializeManifest(manifest) !== text) throw integrity("manifest is not in canonical form");
  return manifest;
}

/** Verifies the signature with the pinned keys, then parses. */
export function verifyManifest(bytes: Uint8Array, signature: string, trusted: readonly TrustedKey[] = TRUSTED_KEYS): VerifiedManifest {
  const result = verifySshSig({ message: bytes, armoredSignature: signature, namespace: NAMESPACE_MANIFEST, principal: SIGNER_PRINCIPAL, trusted });
  if (!result.ok) {
    // A binary that predates a key rotation cannot verify new releases and must be reinstalled.
    const hint = result.reason.startsWith("signed by an untrusted key") ? "; if the Tropos release key was rotated, reinstall with install.sh" : "";
    throw integrity(`manifest signature rejected: ${result.reason}${hint}`);
  }
  return { manifest: parseManifest(bytes), bytes, signature };
}

export function expectVersion(m: Manifest, expected: string): void {
  if (m.version !== expected) throw integrity(`manifest is for version ${m.version}, expected ${expected}`);
}
