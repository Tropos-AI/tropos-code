// src/ui/qr.ts — QR encoder (byte mode, error correction M, versions 1-10). No Node imports: the web app reuses it.

export class QrTooLongError extends Error {
  constructor(bytes: number) {
    super(`${bytes} bytes do not fit in a version-10 QR code`);
    this.name = "QrTooLongError";
  }
}

type Level = "L" | "M" | "Q" | "H";
const LEVEL_BITS: Record<Level, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Level M, versions 1..10: EC codewords per block, then [block count, data codewords per block] groups. */
const M_BLOCKS: { ec: number; groups: [number, number][] }[] = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gfMul(a: number, b: number): number {
  let r = 0;
  for (let i = 7; i >= 0; i--) {
    r = (r << 1) ^ ((r >>> 7) * 0x11d);
    r ^= ((b >>> i) & 1) * a;
  }
  return r;
}

/** Reed-Solomon remainder of `data` over GF(256) (polynomial 0x11d). */
export function rsEncode(data: number[], ecLength: number): number[] {
  const divisor = new Array<number>(ecLength).fill(0);
  divisor[ecLength - 1] = 1;
  let root = 1;
  for (let i = 0; i < ecLength; i++) {
    for (let j = 0; j < ecLength; j++) {
      divisor[j] = gfMul(divisor[j]!, root);
      if (j + 1 < ecLength) divisor[j]! ^= divisor[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  const rem = new Array<number>(ecLength).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < ecLength; i++) rem[i]! ^= gfMul(divisor[i]!, factor);
  }
  return rem;
}

/** The 15 format bits (level + mask, BCH-protected, XOR-masked). */
export function formatBits(level: Level, mask: number): number {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

const bit = (v: number, i: number) => ((v >>> i) & 1) !== 0;

function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const info = M_BLOCKS[version - 1]!;
  const capacity = info.groups.reduce((s, [n, d]) => s + n * d, 0);
  const bits: number[] = [];
  const push = (v: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data: number[], version: number): number[] {
  const { ec, groups } = M_BLOCKS[version - 1]!;
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, len] of groups)
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(at, at + len));
      at += len;
    }
  const ecs = blocks.map((b) => rsEncode(b, ec));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < ec; i++) for (const e of ecs) out.push(e[i]!);
  return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The four standard penalty rules, summed. */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < n; i++) {
    lines.push(m[i]!);
    lines.push(m.map((row) => row[i]!));
  }
  for (const line of lines) {
    // N1: runs of five or more; N3: the 1:1:3:1:1 finder shape with four light modules on a side.
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= n; i++) {
      const s = line.slice(i, i + 11).map((v) => (v ? "1" : "0")).join("");
      if (s === "10111010000" || s === "00001011101") score += 40;
    }
  }
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const v = m[y]![x];
      if (v === m[y]![x + 1] && v === m[y + 1]![x] && v === m[y + 1]![x + 1]) score += 3;
    }
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
  score += 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
  return score;
}

/** The module matrix, true = dark, without a quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const capacity = M_BLOCKS[v - 1]!.groups.reduce((s, [n, d]) => s + n * d, 0);
    if (4 + (v >= 10 ? 16 : 8) + bytes.length * 8 <= capacity * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new QrTooLongError(bytes.length);

  const size = 17 + 4 * version;
  const mod: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, v: boolean) => {
    mod[y]![x] = v;
    fn[y]![x] = true;
  };

  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
      }
  const pos = ALIGN[version - 1]!;
  for (let i = 0; i < pos.length; i++)
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) setFn(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

  const drawFormat = (mask: number) => {
    const bits = formatBits("M", mask);
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i));
    setFn(8, 7, bit(bits, 6));
    setFn(8, 8, bit(bits, 7));
    setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0); // reserves the area so data skips it

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, bit(bits, i));
      setFn(b, a, bit(bits, i));
    }
  }

  const codewords = interleave(dataCodewords(bytes, version), version);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y]![x] && i < codewords.length * 8) {
          mod[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7));
          i++;
        }
      }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y]![x] && MASKS[mask]!(x, y)) mod[y]![x] = !mod[y]![x];
  };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(mod);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return mod;
}

/** Terminal text, two module rows per line. Light modules are the ink so the code reads right on a dark terminal. */
export function renderQr(text: string): string {
  const m = qrMatrix(text);
  const quiet = 4;
  const n = m.length + quiet * 2;
  const light = (r: number, c: number) => {
    const y = r - quiet;
    const x = c - quiet;
    return !(y >= 0 && y < m.length && x >= 0 && x < m.length && m[y]![x]);
  };
  const lines: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let line = "";
    for (let c = 0; c < n; c++) {
      const top = light(r, c);
      const bottom = r + 1 >= n || light(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
