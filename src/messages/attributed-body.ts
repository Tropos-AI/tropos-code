// src/messages/attributed-body.ts — reads message text out of chat.db's attributedBody typedstream blob

const MARKER = new TextEncoder().encode("NSString");

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * macOS leaves `message.text` empty for many messages and stores the text inside an
 * NSAttributedString "typedstream" instead. After the `NSString` class name comes a `+`
 * byte, a length (one byte, or 0x81 plus two bytes, or 0x82 plus four bytes, little-endian)
 * and the UTF-8 text. Returns undefined for anything missing, truncated or not UTF-8.
 */
export function decodeAttributedBody(blob: Uint8Array | null): string | undefined {
  try {
    if (!blob || blob.length === 0) return undefined;
    const marker = indexOfBytes(blob, MARKER);
    if (marker < 0) return undefined;
    const plus = blob.indexOf(0x2b, marker + MARKER.length);
    if (plus < 0) return undefined;
    let pos = plus + 1;
    const first = blob[pos];
    if (first === undefined) return undefined;
    let length: number;
    if (first === 0x81) {
      if (pos + 3 > blob.length) return undefined;
      length = blob[pos + 1]! | (blob[pos + 2]! << 8);
      pos += 3;
    } else if (first === 0x82) {
      if (pos + 5 > blob.length) return undefined;
      length = (blob[pos + 1]! | (blob[pos + 2]! << 8) | (blob[pos + 3]! << 16) | (blob[pos + 4]! << 24)) >>> 0;
      pos += 5;
    } else {
      length = first;
      pos += 1;
    }
    if (pos + length > blob.length) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(blob.subarray(pos, pos + length));
  } catch {
    return undefined;
  }
}
