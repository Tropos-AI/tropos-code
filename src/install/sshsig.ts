// src/install/sshsig.ts
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/** A key from an allowed_signers file. Only ssh-ed25519 keys are ever trusted. */
export interface TrustedKey {
  principal: string;
  publicKey: Uint8Array;
  fingerprint: string;
}

const BEGIN = "-----BEGIN SSH SIGNATURE-----";
const END = "-----END SSH SIGNATURE-----";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  bytes(n: number): Buffer {
    if (n < 0 || this.offset + n > this.buf.length) throw new Error("truncated");
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  uint32(): number {
    return this.bytes(4).readUInt32BE(0);
  }
  string(): Buffer {
    const n = this.uint32();
    if (n > 1 << 16) throw new Error("field too long");
    return this.bytes(n);
  }
  done(): boolean {
    return this.offset === this.buf.length;
  }
}

function sshString(data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(data)]);
}

function decodeEd25519Blob(blob: Buffer): Uint8Array {
  const r = new Reader(blob);
  if (r.string().toString("latin1") !== "ssh-ed25519") throw new Error("not an ssh-ed25519 key");
  const key = r.string();
  if (key.length !== 32 || !r.done()) throw new Error("malformed ssh-ed25519 key");
  return new Uint8Array(key);
}

/** OpenSSH-style fingerprint, as printed by `ssh-keygen -l`. */
export function fingerprint(publicKey: Uint8Array): string {
  const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(publicKey)]);
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Parses "principal ssh-ed25519 <base64> [comment]" lines; '#' lines and blank lines are ignored. */
export function parseAllowedSigners(text: string): TrustedKey[] {
  const keys: TrustedKey[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [principal, type, b64] = line.split(/\s+/);
    try {
      if (!principal || type !== "ssh-ed25519" || !b64 || !BASE64_RE.test(b64)) throw new Error("bad fields");
      const publicKey = decodeEd25519Blob(Buffer.from(b64, "base64"));
      keys.push({ principal, publicKey, fingerprint: fingerprint(publicKey) });
    } catch {
      throw new Error(`allowed_signers line ${i + 1}: expected "<principal> ssh-ed25519 <key> [comment]"`);
    }
  }
  return keys;
}

interface SshSig {
  publicKey: Uint8Array;
  namespace: string;
  hashAlg: "sha256" | "sha512";
  signature: Buffer;
}

function parseSshSig(armored: string): SshSig {
  const text = armored.trim();
  if (!text.startsWith(BEGIN) || !text.endsWith(END)) throw new Error("missing SSH SIGNATURE armour");
  const body = text.slice(BEGIN.length, text.length - END.length).replace(/\s+/g, "");
  if (!BASE64_RE.test(body)) throw new Error("bad base64");
  const r = new Reader(Buffer.from(body, "base64"));
  if (r.bytes(6).toString("latin1") !== "SSHSIG") throw new Error("bad magic");
  if (r.uint32() !== 1) throw new Error("unsupported SSHSIG version");
  const publicKey = decodeEd25519Blob(r.string());
  const namespace = r.string().toString("utf8");
  // ssh-keygen signs over an empty reserved field only; anything else is not a signature it accepts.
  if (r.string().length !== 0) throw new Error("reserved field is not empty");
  const hashAlg = r.string().toString("latin1");
  if (hashAlg !== "sha256" && hashAlg !== "sha512") throw new Error(`unsupported hash ${hashAlg}`);
  const sigBlob = new Reader(r.string());
  if (sigBlob.string().toString("latin1") !== "ssh-ed25519") throw new Error("not an ed25519 signature");
  const signature = sigBlob.string();
  if (signature.length !== 64 || !sigBlob.done() || !r.done()) throw new Error("malformed signature");
  return { publicKey, namespace, hashAlg, signature };
}

export interface VerifyRequest {
  message: Uint8Array;
  armoredSignature: string;
  namespace: string;
  principal: string;
  trusted: readonly TrustedKey[];
}

export type VerifyResult = { ok: true; key: TrustedKey } | { ok: false; reason: string };

/** Verifies an SSHSIG signature the way `ssh-keygen -Y verify -I <principal> -n <namespace>` does. */
export function verifySshSig(req: VerifyRequest): VerifyResult {
  let sig: SshSig;
  try {
    sig = parseSshSig(req.armoredSignature);
  } catch (e) {
    return { ok: false, reason: `unreadable signature: ${(e as Error).message}` };
  }
  if (sig.namespace !== req.namespace) {
    return { ok: false, reason: `signature is for namespace "${sig.namespace}", expected "${req.namespace}"` };
  }
  const key = req.trusted.find((k) => k.principal === req.principal && Buffer.from(k.publicKey).equals(Buffer.from(sig.publicKey)));
  if (!key) return { ok: false, reason: `signed by an untrusted key (${fingerprint(sig.publicKey)})` };
  const digest = createHash(sig.hashAlg).update(req.message).digest();
  const signed = Buffer.concat([
    Buffer.from("SSHSIG"),
    sshString(Buffer.from(req.namespace)),
    sshString(new Uint8Array(0)),
    sshString(Buffer.from(sig.hashAlg)),
    sshString(digest),
  ]);
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key.publicKey)]), format: "der", type: "spki" });
  return cryptoVerify(null, signed, publicKey, sig.signature) ? { ok: true, key } : { ok: false, reason: "signature does not match" };
}
