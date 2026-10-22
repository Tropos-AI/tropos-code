// eval/lib/split.ts — a train/test split that is the same on every machine: a seeded shuffle of the sorted names.

/** mulberry32: a small seeded generator, so the split is the same on every machine. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function splitTasks(names: string[], seed: number, train: number): { train: string[]; test: string[] } {
  const random = seeded(seed);
  const shuffled = [...names].sort();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return { train: shuffled.slice(0, train).sort(), test: shuffled.slice(train).sort() };
}
