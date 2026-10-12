import { describe, expect, test } from "bun:test";
import { evaluate } from "./check-coverage";

const record = (path: string, found: number, hit: number) => `SF:${path}\nLF:${found}\nLH:${hit}\nend_of_record\n`;

describe("evaluate", () => {
  test("passes when every src file and the total are above the threshold", () => {
    const report = evaluate(record("src/a.ts", 10, 9) + record("src/b.ts", 10, 8), 0.8);
    expect(report.ok).toBe(true);
    expect(report.overall).toBeCloseTo(0.85);
  });

  test("fails and names a file at 50%", () => {
    const report = evaluate(record("src/good.ts", 100, 100) + record("src/weak.ts", 10, 5), 0.8);
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain("src/weak.ts");
    expect(report.failures[0]).toContain("50.0%");
  });

  test("fails when the overall figure is below the threshold", () => {
    const report = evaluate(record("src/a.ts", 10, 8) + record("src/b.ts", 10, 8) + record("src/c.ts", 10, 10), 0.99);
    expect(report.failures.some((f) => f.startsWith("overall"))).toBe(true);
  });

  test("ignores files outside src/ and fails when there are none in src/", () => {
    expect(evaluate(record("test/helpers/x.ts", 10, 1) + record("src/a.ts", 10, 10), 0.8).ok).toBe(true);
    expect(evaluate(record("test/helpers/x.ts", 10, 10), 0.8).ok).toBe(false);
  });
});
