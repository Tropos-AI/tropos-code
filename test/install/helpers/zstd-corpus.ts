// test/install/helpers/zstd-corpus.ts
// The shared zstd corpus (spec R8.1): decompress.ts and install.sh must reject every invalid case.
// Each case carries the bytes the manifest promises (`promised`), so a test can serve them as an
// honest raw fallback and check that only the .zst is rejected.
export interface ZstdCase {
  name: string;
  zst: Uint8Array;
  promised: Uint8Array;
  valid: boolean;
}

export const sha256Hex = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
export const expectedOf = (c: ZstdCase) => ({ size: c.promised.length, sha256: sha256Hex(c.promised) });

const concat = (...parts: Array<Uint8Array | string>) => new Uint8Array(Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p) : Buffer.from(p)))));

/** `raw` must be at least 16 bytes; its second-to-last byte is flipped for the wrong-sha256 case. */
export function zstdCorpus(raw: Uint8Array = new Uint8Array(65536).map((_, i) => (i * 7919) % 251)): ZstdCase[] {
  const good = Bun.zstdCompressSync(raw);
  const flipped = new Uint8Array(good);
  flipped[flipped.length - 2]! ^= 0xff;
  const altered = new Uint8Array(raw);
  altered[altered.length - 2]! ^= 0x01;
  return [
    { name: "good", zst: good, promised: raw, valid: true },
    { name: "truncated-frame", zst: good.subarray(0, good.length - 7), promised: raw, valid: false },
    { name: "trailing-garbage", zst: concat(good, "garbage"), promised: raw, valid: false },
    { name: "extra-frame", zst: concat(good, good), promised: raw, valid: false },
    { name: "corrupted-checksum", zst: flipped, promised: raw, valid: false },
    { name: "not-zstd", zst: concat("not zstd at all"), promised: raw, valid: false },
    { name: "empty", zst: new Uint8Array(0), promised: raw, valid: false },
    { name: "output-one-byte-too-long", zst: good, promised: raw.subarray(0, raw.length - 1), valid: false },
    { name: "output-one-byte-too-short", zst: Bun.zstdCompressSync(raw.subarray(0, raw.length - 1)), promised: raw, valid: false },
    { name: "wrong-sha256", zst: good, promised: altered, valid: false },
    { name: "bomb", zst: Bun.zstdCompressSync(new Uint8Array(64 * 1024 * 1024)), promised: raw, valid: false },
  ];
}
