import { expect, test } from "bun:test";
import jsQR from "jsqr";
import { QrTooLongError, formatBits, qrMatrix, renderQr, rsEncode } from "./qr";

const SCALE = 4;
const QUIET = 4;

/** Scale each module to 4x4 pixels with a white border, as a camera would see it. */
function decode(m: boolean[][]): string | undefined {
  const n = m.length + QUIET * 2;
  const w = n * SCALE;
  const data = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let r = 0; r < m.length; r++)
    for (let c = 0; c < m.length; c++) {
      if (!m[r]![c]) continue;
      for (let y = 0; y < SCALE; y++)
        for (let x = 0; x < SCALE; x++) {
          const i = (((r + QUIET) * SCALE + y) * w + (c + QUIET) * SCALE + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
  return jsQR(data, w, w)?.data;
}

/** Map the half-block text back to a module matrix (light = ink) and decode it. */
function decodeTerminal(text: string): string | undefined {
  const lines = text.split("\n");
  const n = lines[0]!.length;
  const dark: boolean[][] = [];
  for (const line of lines) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const ch of line) {
      top.push(ch === "▄" || ch === " ");
      bottom.push(ch === "▀" || ch === " ");
    }
    dark.push(top, bottom);
  }
  // Strip the quiet zone (and any padding row) to get the bare matrix.
  const size = n - QUIET * 2;
  const bare = dark.slice(QUIET, QUIET + size).map((row) => row.slice(QUIET, QUIET + size));
  return decode(bare);
}

test("Reed-Solomon matches the HELLO WORLD 1-M reference", () => {
  expect(rsEncode([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10)).toEqual([
    196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
  ]);
});

test("format bits for level M, mask 0", () => expect(formatBits("M", 0)).toBe(0b101010000010010));

test("size is 17 + 4·version, finder patterns in three corners", () => {
  const m = qrMatrix("https://x.ts.net/");
  expect(m.length % 4).toBe(1);
  expect(m.every((row) => row.length === m.length)).toBe(true);
  for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]] as const) expect(m[r + 3]![c + 3]).toBe(true);
});

for (const text of ["hello", "https://mac.tail1234.ts.net:8443/", "x".repeat(150)])
  test(`round-trips through jsQR: ${text.length} chars`, () => expect(decode(qrMatrix(text))).toBe(text));

test("renderQr draws light modules (and a 4-module quiet zone) as blocks, two rows per line", () => {
  const out = renderQr("hello");
  const lines = out.split("\n");
  expect(lines[0]).toMatch(/^█+$/);
  expect(new Set(lines.map((l) => [...l].length)).size).toBe(1);
  expect(lines.length).toBe(Math.ceil((qrMatrix("hello").length + 8) / 2));
  expect(decodeTerminal(out)).toBe("hello");
});

test("too long throws QrTooLongError", () => expect(() => qrMatrix("x".repeat(300))).toThrow(QrTooLongError));
