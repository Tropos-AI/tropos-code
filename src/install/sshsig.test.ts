// src/install/sshsig.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTestKey, sshSign, type TestKey } from "../../test/install/helpers/keys";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { parseAllowedSigners, verifySshSig } from "./sshsig";

let dir: string;
let k1: TestKey, k2: TestKey, ec: TestKey;
const message = new TextEncoder().encode('{"hello":"world"}\n');

beforeAll(async () => {
  dir = await makeTmpDir();
  [k1, k2, ec] = await Promise.all([makeTestKey(dir, "k1"), makeTestKey(dir, "k2"), makeTestKey(dir, "ec", "ecdsa")]);
});
afterAll(() => removeDir(dir));

const req = (armoredSignature: string, overrides: Partial<Parameters<typeof verifySshSig>[0]> = {}) => ({
  message,
  armoredSignature,
  namespace: "tropos-manifest",
  principal: "tropos-release",
  trusted: k1.trusted,
  ...overrides,
});

async function sshKeygenAccepts(sig: string, signers: string, data: Uint8Array, namespace = "tropos-manifest"): Promise<boolean> {
  await writeFile(join(dir, "s.sig"), sig);
  await writeFile(join(dir, "signers"), signers);
  await writeFile(join(dir, "data"), data);
  const r = await Bun.$`ssh-keygen -Y verify -f ${join(dir, "signers")} -I tropos-release -n ${namespace} -s ${join(dir, "s.sig")} < ${join(dir, "data")}`.quiet().nothrow();
  return r.exitCode === 0;
}

describe("verifySshSig", () => {
  test("accepts a signature from a trusted key (sha512, the ssh-keygen default)", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const r = verifySshSig(req(sig));
    expect(r.ok).toBe(true);
    expect(await sshKeygenAccepts(sig, k1.signersLine + "\n", message)).toBe(true);
  });

  test("accepts hashalg=sha256", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir, ["-O", "hashalg=sha256"]);
    expect(verifySshSig(req(sig)).ok).toBe(true);
  });

  test("rejects another namespace", async () => {
    const sig = await sshSign(k1, message, "tropos-installer", dir);
    const r = verifySshSig(req(sig));
    expect(r).toEqual({ ok: false, reason: 'signature is for namespace "tropos-installer", expected "tropos-manifest"' });
    expect(await sshKeygenAccepts(sig, k1.signersLine + "\n", message)).toBe(false);
  });

  test("rejects an untrusted key", async () => {
    const sig = await sshSign(k2, message, "tropos-manifest", dir);
    const r = verifySshSig(req(sig));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toStartWith("signed by an untrusted key (SHA256:");
  });

  test("rejects a trusted key listed under another principal", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const other = parseAllowedSigners(k1.signersLine.replace("tropos-release", "someone-else"));
    expect(verifySshSig(req(sig, { trusted: other })).ok).toBe(false);
  });

  test("rejects a modified message", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const changed = new Uint8Array(message);
    changed[3]! ^= 1;
    expect(verifySshSig(req(sig, { message: changed }))).toEqual({ ok: false, reason: "signature does not match" });
  });

  test("rejects a modified signature", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const lines = sig.trim().split("\n");
    const body = lines.slice(1, -1).join("");
    const raw = Buffer.from(body, "base64");
    raw[raw.length - 5]! ^= 1; // inside the 64-byte ed25519 signature at the end of the blob
    const tampered = [lines[0], raw.toString("base64"), lines.at(-1)].join("\n");
    expect(verifySshSig(req(tampered)).ok).toBe(false);
  });

  test.each([
    ["missing END line", (s: string) => s.trim().split("\n").slice(0, -1).join("\n")],
    ["empty", () => ""],
    ["not base64", (s: string) => s.replace(/\n[A-Za-z0-9+/]/, "\n!")],
    ["truncated body", (s: string) => { const l = s.trim().split("\n"); return [l[0], l[1]!.slice(0, 20), l.at(-1)].join("\n"); }],
  ])("rejects an unreadable signature: %s", async (_name, mangle) => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const r = verifySshSig(req(mangle(sig)));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toStartWith("unreadable signature");
  });

  test("rejects non-ed25519 signatures", async () => {
    const sig = await sshSign(ec, message, "tropos-manifest", dir);
    expect(verifySshSig(req(sig)).ok).toBe(false);
  });

  test("an empty trusted set rejects everything", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    expect(verifySshSig(req(sig, { trusted: [] })).ok).toBe(false);
  });
});

describe("parseAllowedSigners", () => {
  test("skips comments and blanks; fingerprint matches ssh-keygen -l", async () => {
    const keys = parseAllowedSigners(`# comment\n\n${k1.signersLine} k1-comment\n${k2.signersLine}\n`);
    expect(keys.map((k) => k.principal)).toEqual(["tropos-release", "tropos-release"]);
    const listed = (await Bun.$`ssh-keygen -lf ${k1.privatePath}.pub`.text()).split(" ")[1];
    expect(keys[0]!.fingerprint).toBe(listed!);
  });

  test.each([
    ["wrong key type", "tropos-release ssh-rsa AAAAB3NzaC1yc2E="],
    ["options before the key type", 'tropos-release namespaces="x" ssh-ed25519 AAAA'],
    ["missing key", "tropos-release ssh-ed25519"],
    ["bad base64", "tropos-release ssh-ed25519 !!!!"],
  ])("rejects %s", (_name, line) => {
    expect(() => parseAllowedSigners(line)).toThrow("allowed_signers line 1");
  });
});

describe("reserved field", () => {
  const sshStr = (data: Uint8Array | string): Buffer => {
    const b = Buffer.from(data);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    return Buffer.concat([len, b]);
  };

  /** Builds an SSHSIG envelope with node:crypto, signing over the given reserved field. */
  function craftSignature(reserved: Buffer, namespace = "tropos-manifest", hashAlg = "sha512"): { armored: string; trusted: ReturnType<typeof parseAllowedSigners> } {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
    const pubBlob = Buffer.concat([sshStr("ssh-ed25519"), sshStr(raw)]);
    const digest = createHash("sha512").update(message).digest();
    const signed = Buffer.concat([
      Buffer.from("SSHSIG"),
      sshStr(namespace),
      sshStr(reserved),
      sshStr(hashAlg),
      sshStr(digest),
    ]);
    const sigBytes = cryptoSign(null, signed, privateKey);
    const sigBlob = Buffer.concat([sshStr("ssh-ed25519"), sshStr(sigBytes)]);
    const envelope = Buffer.concat([
      Buffer.from("SSHSIG"),
      Buffer.from([0, 0, 0, 1]),
      sshStr(pubBlob),
      sshStr(namespace),
      sshStr(reserved),
      sshStr(hashAlg),
      sshStr(sigBlob),
    ]);
    const b64 = envelope.toString("base64").match(/.{1,70}/g)!.join("\n");
    return {
      armored: `-----BEGIN SSH SIGNATURE-----\n${b64}\n-----END SSH SIGNATURE-----\n`,
      trusted: parseAllowedSigners(`tropos-release ssh-ed25519 ${pubBlob.toString("base64")}`),
    };
  }

  test("accepts a signature whose reserved field is empty (helper sanity check)", () => {
    const { armored, trusted } = craftSignature(Buffer.alloc(0));
    expect(verifySshSig({ message, armoredSignature: armored, namespace: "tropos-manifest", principal: "tropos-release", trusted }).ok).toBe(true);
  });

  test("rejects a signature with a non-empty reserved field, as ssh-keygen does", () => {
    const { armored, trusted } = craftSignature(Buffer.from("x"));
    const r = verifySshSig({ message, armoredSignature: armored, namespace: "tropos-manifest", principal: "tropos-release", trusted });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toStartWith("unreadable signature");
  });

  test("never echoes a hostile namespace or hash name raw (terminal escapes stay escaped)", () => {
    const hostile = "x\u001b]0;pwned\u0007\u001b[2J\nfake line";
    for (const r of [
      verifySshSig({ message, armoredSignature: craftSignature(Buffer.alloc(0), hostile).armored, namespace: "tropos-manifest", principal: "tropos-release", trusted: k1.trusted }),
      verifySshSig({ message, armoredSignature: craftSignature(Buffer.alloc(0), "tropos-manifest", hostile).armored, namespace: "tropos-manifest", principal: "tropos-release", trusted: k1.trusted }),
    ]) {
      expect(r.ok).toBe(false);
      const reason = (r as { reason: string }).reason;
      expect(reason).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(reason).toContain(JSON.stringify(hostile));
    }
  });
});
