// src/install/version.ts
/** Release versions are plain MAJOR.MINOR.PATCH (spec §5.3); no prerelease or build suffixes. */
export const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && VERSION_RE.test(value);
}

function parts(v: string): [bigint, bigint, bigint] {
  if (!isVersion(v)) throw new Error(`not a version: ${JSON.stringify(v)}`);
  const [a, b, c] = v.split(".").map((n) => BigInt(n));
  return [a!, b!, c!];
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

export function newestFirst(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a));
}
