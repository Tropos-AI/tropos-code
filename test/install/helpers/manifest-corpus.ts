// test/install/helpers/manifest-corpus.ts
// The shared manifest corpus (spec §13 layers 1 and 7): manifest.ts, manifest.awk and install.sh must agree on every case.
import { serializeManifest, type Manifest } from "../../../src/install/manifest";
import { PLATFORMS } from "../../../src/install/platform";

export interface CorpusCase {
  name: string;
  text: string;
}

const hex = (i: number, c: string) => (String(i) + c.repeat(64)).slice(0, 64);

export function sampleManifest(version = "1.2.3", size = (i: number) => 1000 + i): Manifest {
  const platforms = Object.fromEntries(
    PLATFORMS.map((p, i) => [p, { asset: `tropos-${p}`, sha256: hex(i, "a"), size: size(i), zst: { asset: `tropos-${p}.zst`, sha256: hex(i, "b"), size: 500 + i } }]),
  );
  return { schema: 1, version, commit: "0123456789abcdef0123456789abcdef01234567", buildDate: "2026-10-13T12:00:00Z", platforms } as Manifest;
}

const VALID = serializeManifest(sampleManifest());

function replaceOnce(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`corpus: "${from}" not found`);
  return text.replace(from, () => to);
}

function json(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function withPlatforms(mutate: (platforms: Record<string, unknown>) => Record<string, unknown>): string {
  const m = JSON.parse(VALID) as { platforms: Record<string, unknown> };
  return json({ ...m, platforms: mutate(m.platforms) });
}

const firstSha = hex(0, "a");

export const VALID_CORPUS: CorpusCase[] = [
  { name: "sample", text: VALID },
  { name: "version-0.0.1", text: serializeManifest(sampleManifest("0.0.1")) },
  { name: "size-bounds", text: serializeManifest(sampleManifest("2.0.0", (i) => (i % 2 === 0 ? 1 : 1073741824))) },
];

export const INVALID_CORPUS: CorpusCase[] = [
  { name: "empty", text: "" },
  { name: "not-json", text: "hello\n" },
  { name: "bom", text: `﻿${VALID}` },
  { name: "crlf", text: VALID.replace(/\n/g, "\r\n") },
  { name: "tab-indent", text: replaceOnce(VALID, '  "schema"', '\t"schema"') },
  { name: "trailing-space", text: replaceOnce(VALID, '"schema": 1,', '"schema": 1, ') },
  { name: "no-final-newline", text: VALID.slice(0, -1) },
  { name: "two-final-newlines", text: `${VALID}\n` },
  { name: "huge", text: `{${" ".repeat(70_000)}\n` },
  { name: "nul-at-end-of-line", text: replaceOnce(VALID, '  "schema": 1,', '  "schema": 1,\u0000') },
  { name: "nul-then-bytes", text: replaceOnce(VALID, '  "schema": 1,', '  "schema": 1,\u0000AB') },
  { name: "nul-at-end-of-sha-line", text: VALID.replace(/(      "sha256": "[0-9a-f]{64}",)/, "$1\u0000") },
  { name: "nul-byte", text: replaceOnce(VALID, '"commit": "0', '"commit": "\u00000') },
  { name: "duplicate-version-key", text: replaceOnce(VALID, '  "version": "1.2.3",\n', '  "version": "1.2.3",\n  "version": "9.9.9",\n') },
  { name: "duplicate-identical-key", text: replaceOnce(VALID, '  "version": "1.2.3",\n', '  "version": "1.2.3",\n  "version": "1.2.3",\n') },
  { name: "extra-field", text: replaceOnce(VALID, '  "platforms": {', '  "extra": 1,\n  "platforms": {') },
  { name: "reordered-keys", text: replaceOnce(VALID, '  "version": "1.2.3",\n  "commit": "0123456789abcdef0123456789abcdef01234567",\n', '  "commit": "0123456789abcdef0123456789abcdef01234567",\n  "version": "1.2.3",\n') },
  { name: "schema-2", text: replaceOnce(VALID, '"schema": 1', '"schema": 2') },
  { name: "version-two-parts", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "1.2"') },
  { name: "version-leading-zero", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "01.2.3"') },
  { name: "version-prerelease", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "1.2.3-beta"') },
  { name: "version-traversal", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "../1.2.3"') },
  { name: "version-escaped", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "\\u0031.2.3"') },
  { name: "commit-short", text: replaceOnce(VALID, "0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123456789abcdef0123456") },
  { name: "build-date", text: replaceOnce(VALID, "2026-10-13T12:00:00Z", "2026-10-13 12:00:00Z") },
  { name: "sha-uppercase", text: replaceOnce(VALID, firstSha, firstSha.toUpperCase()) },
  { name: "sha-63", text: replaceOnce(VALID, firstSha, firstSha.slice(1)) },
  { name: "size-zero", text: replaceOnce(VALID, '"size": 1000,', '"size": 0,') },
  { name: "size-leading-zero", text: replaceOnce(VALID, '"size": 1000,', '"size": 01000,') },
  { name: "size-too-large", text: replaceOnce(VALID, '"size": 1000,', '"size": 1073741825,') },
  { name: "size-fraction", text: replaceOnce(VALID, '"size": 1000,', '"size": 1000.5,') },
  { name: "size-negative", text: replaceOnce(VALID, '"size": 1000,', '"size": -1000,') },
  { name: "size-string", text: replaceOnce(VALID, '"size": 1000,', '"size": "1000",') },
  { name: "asset-name", text: replaceOnce(VALID, '"asset": "tropos-darwin-arm64",', '"asset": "tropos-darwin-x64",') },
  { name: "asset-traversal", text: replaceOnce(VALID, '"asset": "tropos-darwin-arm64",', '"asset": "../tropos-darwin-arm64",') },
  { name: "zst-asset-name", text: replaceOnce(VALID, '"asset": "tropos-darwin-arm64.zst"', '"asset": "tropos-darwin-arm64"') },
  { name: "missing-platform", text: withPlatforms(({ "linux-arm64-musl": _, ...rest }) => rest) },
  { name: "extra-platform", text: withPlatforms((p) => ({ ...p, "win32-x64": p["linux-x64"] })) },
  { name: "platform-order", text: withPlatforms(({ "darwin-arm64": first, ...rest }) => ({ ...rest, "darwin-arm64": first })) },
];
