// src/harness/domain.ts — the domain a project belongs to, for the harness library: its language and runtime, read from
// the files at its root. Lessons about method transfer across repositories of one stack better than across stacks.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DOMAINS = ["ts-bun", "ts-node", "python", "rust", "go", "general"] as const;
export type Domain = (typeof DOMAINS)[number];

/** The first marker found decides; a folder with none of them is "general". */
const MARKERS: [Domain, string[]][] = [
  ["ts-bun", ["bun.lock", "bun.lockb", "bunfig.toml"]],
  ["ts-node", ["package.json"]],
  ["rust", ["Cargo.toml"]],
  ["go", ["go.mod"]],
  ["python", ["pyproject.toml", "setup.py", "requirements.txt"]],
];

/** A package.json whose scripts run bun, or that depends on Bun's types, is a Bun project even without a lockfile. */
const BUN_SCRIPT = /(^|[\s;&|])(bun|bunx)\s/;

function usesBun(dir: string, read: (path: string) => string | null): boolean {
  try {
    const pkg = JSON.parse(read(join(dir, "package.json")) ?? "{}") as { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    return Object.values(pkg.scripts ?? {}).some((s) => typeof s === "string" && BUN_SCRIPT.test(` ${s}`)) || "@types/bun" in (pkg.devDependencies ?? {}) || "bun-types" in (pkg.devDependencies ?? {});
  } catch {
    return false;
  }
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export function detectDomain(dir: string, exists: (path: string) => boolean = existsSync, read: (path: string) => string | null = readText): Domain {
  for (const [domain, files] of MARKERS) {
    if (!files.some((f) => exists(join(dir, f)))) continue;
    return domain === "ts-node" && usesBun(dir, read) ? "ts-bun" : domain;
  }
  return "general";
}

export function isDomain(value: string): value is Domain {
  return (DOMAINS as readonly string[]).includes(value);
}
