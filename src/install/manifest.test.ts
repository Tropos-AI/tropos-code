// src/install/manifest.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { INVALID_CORPUS, VALID_CORPUS, sampleManifest } from "../../test/install/helpers/manifest-corpus";
import { makeTestKey, sshSign, type TestKey } from "../../test/install/helpers/keys";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { InstallError } from "./errors";
import { expectVersion, parseManifest, serializeManifest, verifyManifest } from "./manifest";

const enc = (s: string) => new TextEncoder().encode(s);
let dir: string;
let key: TestKey;
let other: TestKey;
beforeAll(async () => {
  dir = await makeTmpDir();
  [key, other] = await Promise.all([makeTestKey(dir, "k"), makeTestKey(dir, "other")]);
});
afterAll(() => removeDir(dir));

describe("manifest", () => {
  test("serializeManifest is the canonical form of spec §5.3", () => {
    const text = serializeManifest(sampleManifest());
    const lines = text.split("\n");
    expect(lines.length).toBe(69); // 68 lines + the empty string after the final newline
    expect(lines.slice(0, 7)).toEqual(["{", '  "schema": 1,', '  "version": "1.2.3",', '  "commit": "0123456789abcdef0123456789abcdef01234567",', '  "buildDate": "2026-10-13T12:00:00Z",', '  "platforms": {', '    "darwin-arm64": {']);
    expect(lines.slice(-3)).toEqual(["  }", "}", ""]);
  });

  test.each(VALID_CORPUS.map((c) => [c.name, c.text]))("accepts %s", (_name, text) => {
    expect(serializeManifest(parseManifest(enc(text)))).toBe(text);
  });

  test.each(INVALID_CORPUS.map((c) => [c.name, c.text]))("rejects %s", (_name, text) => {
    const run = () => parseManifest(enc(text));
    expect(run).toThrow(InstallError);
    try {
      run();
    } catch (e) {
      expect((e as InstallError).kind).toBe("integrity");
    }
  });

  test("rejects invalid UTF-8", () => {
    const bytes = enc(serializeManifest(sampleManifest()));
    bytes[20] = 0xff;
    expect(() => parseManifest(bytes)).toThrow("manifest is not UTF-8");
  });

  test("verifyManifest checks the signature before parsing", async () => {
    const bytes = enc("not even json\n");
    const sig = await sshSign(other, bytes, "tropos-manifest", dir);
    expect(() => verifyManifest(bytes, sig, key.trusted)).toThrow("manifest signature rejected: signed by an untrusted key");
  });

  test("verifyManifest accepts a signed canonical manifest", async () => {
    const bytes = enc(serializeManifest(sampleManifest("0.4.0")));
    const sig = await sshSign(key, bytes, "tropos-manifest", dir);
    const v = verifyManifest(bytes, sig, key.trusted);
    expect(v.manifest.version).toBe("0.4.0");
    expect(v.signature).toBe(sig);
  });

  test("verifyManifest rejects a signed but malformed manifest", async () => {
    const bytes = enc(INVALID_CORPUS.find((c) => c.name === "duplicate-version-key")!.text);
    const sig = await sshSign(key, bytes, "tropos-manifest", dir);
    expect(() => verifyManifest(bytes, sig, key.trusted)).toThrow("manifest is not in canonical form");
  });

  test("verifyManifest with the default (empty) key set fails closed", async () => {
    const bytes = enc(serializeManifest(sampleManifest()));
    const sig = await sshSign(key, bytes, "tropos-manifest", dir);
    expect(() => verifyManifest(bytes, sig)).toThrow("untrusted key");
  });

  test("expectVersion", () => {
    expect(() => expectVersion(sampleManifest("1.0.0"), "1.0.1")).toThrow("manifest is for version 1.0.0, expected 1.0.1");
    expect(() => expectVersion(sampleManifest("1.0.0"), "1.0.0")).not.toThrow();
  });
});
