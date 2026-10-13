// Runs the test suite with coverage and enforces a per-file and overall line-coverage floor.
// (Bun's own coverageThreshold setting does not enforce a line-only floor, so we check lcov ourselves.)
import { readFile } from "node:fs/promises";

export interface CoverageReport {
  ok: boolean;
  overall: number;
  failures: string[];
}

/** Source files allowed to be absent from the coverage report (no test loads them), with the reason. */
export const EXEMPT: Record<string, string> = {
  "src/index.ts": "entry shim; exercised by the compiled-binary e2e tests",
  "src/agent/events.ts": "type-only module",
  "src/ui/runtime.ts": "type-only module",
  "src/install/build-flags.ts": "test-build branches run only in compiled e2e binaries (amendment A3)",
};

/** Every non-test source file under src/, as repo-relative paths. */
export async function listSourceFiles(root = "."): Promise<string[]> {
  const files = await Array.fromAsync(new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: root }));
  return files.filter((f) => !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts")).sort();
}

/**
 * Parses lcov text and checks every `src/` file, and the `src/` total, against `threshold` (0..1).
 * Files in `files` that the report never mentions (no test loads them) count as uncovered unless exempt.
 */
export function evaluate(
  lcovText: string,
  threshold: number,
  files: string[] = [],
  exempt: Record<string, string> = EXEMPT,
): CoverageReport {
  const records: Array<{ path: string; found: number; hit: number }> = [];
  let current: { path: string; found: number; hit: number } | undefined;
  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) current = { path: line.slice(3).trim(), found: 0, hit: 0 };
    else if (current && line.startsWith("LF:")) current.found = Number(line.slice(3));
    else if (current && line.startsWith("LH:")) current.hit = Number(line.slice(3));
    else if (line.trim() === "end_of_record" && current) {
      records.push(current);
      current = undefined;
    }
  }
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const source = records.filter((f) => /(^|\/)src\//.test(norm(f.path)));
  const pct = (hit: number, found: number) => (found === 0 ? 1 : hit / found);
  const fmt = (n: number) => `${(n * 100).toFixed(1)}%`;

  const failures = source
    .filter((f) => !(norm(f.path) in exempt))
    .filter((f) => pct(f.hit, f.found) < threshold)
    .map((f) => `${f.path}: ${fmt(pct(f.hit, f.found))} of lines covered (need ${fmt(threshold)})`);
  const reported = new Set(records.map((f) => norm(f.path)));
  for (const file of files) {
    if (!reported.has(file) && !(file in exempt)) failures.push(`${file}: not loaded by any test, so 0% covered`);
  }
  const found = source.reduce((n, f) => n + f.found, 0);
  const hit = source.reduce((n, f) => n + f.hit, 0);
  const overall = pct(hit, found);
  if (source.length === 0) failures.push("no src/ files found in the coverage report");
  if (overall < threshold) failures.push(`overall: ${fmt(overall)} of lines covered (need ${fmt(threshold)})`);
  return { ok: failures.length === 0, overall, failures };
}

if (import.meta.main) {
  const THRESHOLD = 0.8;
  const proc = Bun.spawn(["bun", "test", "--coverage", "--coverage-reporter=lcov", "--coverage-dir=coverage"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) process.exit(1);
  const report = evaluate(await readFile("coverage/lcov.info", "utf8"), THRESHOLD, await listSourceFiles());
  if (!report.ok) {
    console.error("\nCoverage below threshold:");
    for (const failure of report.failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`\nLine coverage OK: ${(report.overall * 100).toFixed(1)}% overall, every src/ file >= ${THRESHOLD * 100}%`);
}
