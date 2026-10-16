import { describe, expect, test } from "bun:test";
import { EXEMPT, evaluate } from "./check-coverage";

const record = (path: string, found: number, hit: number) => `SF:${path}\nLF:${found}\nLH:${hit}\nend_of_record\n`;

describe("evaluate", () => {
  test("passes when every src file and the total are above the threshold", () => {
    const report = evaluate(record("src/a.ts", 10, 9) + record("src/b.ts", 10, 8), 0.8, ["src/a.ts", "src/b.ts"], {});
    expect(report.ok).toBe(true);
    expect(report.overall).toBeCloseTo(0.85);
  });

  test("fails and names a file at 50%", () => {
    const report = evaluate(record("src/good.ts", 100, 100) + record("src/weak.ts", 10, 5), 0.8, ["src/good.ts", "src/weak.ts"], {});
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain("src/weak.ts");
    expect(report.failures[0]).toContain("50.0%");
  });

  test("fails when the overall figure is below the threshold", () => {
    const report = evaluate(record("src/a.ts", 10, 8) + record("src/b.ts", 10, 8) + record("src/c.ts", 10, 10), 0.99, [], {});
    expect(report.failures.some((f) => f.startsWith("overall"))).toBe(true);
  });

  test("ignores files outside src/ and fails when there are none in src/", () => {
    expect(evaluate(record("test/helpers/x.ts", 10, 1) + record("src/a.ts", 10, 10), 0.8, ["src/a.ts"], {}).ok).toBe(true);
    expect(evaluate(record("test/helpers/x.ts", 10, 10), 0.8, [], {}).ok).toBe(false);
  });

  test("a source file that no test loads counts as uncovered, by name", () => {
    const lcov = record("src/a.ts", 10, 10);
    const report = evaluate(lcov, 0.8, ["src/a.ts", "src/never-loaded.ts"], {});
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain("src/never-loaded.ts");
    expect(report.failures[0]).toContain("not loaded by any test");
  });

  test("exempt files are not held to the per-file threshold", () => {
    const lcov = record("src/a.ts", 10, 10) + record("src/flags.ts", 4, 3);
    expect(evaluate(lcov, 0.8, ["src/a.ts", "src/flags.ts"], {}).ok).toBe(false);
    expect(evaluate(lcov, 0.8, ["src/a.ts", "src/flags.ts"], { "src/flags.ts": "test-build only" }).ok).toBe(true);
  });

  test("an exempt file that no test loads passes", () => {
    const lcov = record("src/a.ts", 10, 10);
    expect(evaluate(lcov, 0.8, ["src/a.ts", "src/shim.ts"], { "src/shim.ts": "entry shim" }).ok).toBe(true);
  });

  test("the built-in exemptions are explicit and explained", () => {
    expect(Object.keys(EXEMPT).sort()).toEqual(["src/agent/events.ts", "src/cli/lifecycle/types.ts", "src/doctor/types.ts", "src/exec/backend.ts", "src/gateway/types.ts", "src/index.ts", "src/install/build-flags.ts", "src/service/types.ts", "src/ui/runtime.ts"]);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(5);
  });
});
