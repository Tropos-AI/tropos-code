// src/harness/domain.ts — the domain a project belongs to, for the harness library: its language and runtime, read from
// the files at its root. Lessons about method transfer across repositories of one stack better than across stacks.
import { existsSync } from "node:fs";
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

export function detectDomain(dir: string, exists: (path: string) => boolean = existsSync): Domain {
  for (const [domain, files] of MARKERS) if (files.some((f) => exists(join(dir, f)))) return domain;
  return "general";
}

export function isDomain(value: string): value is Domain {
  return (DOMAINS as readonly string[]).includes(value);
}
