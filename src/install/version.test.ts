// src/install/version.test.ts
import { describe, expect, test } from "bun:test";
import { compareVersions, isVersion, newestFirst } from "./version";

describe("isVersion", () => {
  test.each(["0.0.0", "1.2.3", "10.20.30", "0.1.0"])("accepts %s", (v) => expect(isVersion(v)).toBe(true));
  test.each(["", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "1.2.3-beta", "v1.2.3", "../1.2.3", " 1.2.3", "1.2.3\n", "1".repeat(40) + ".0.0"])(
    "rejects %j",
    (v) => expect(isVersion(v)).toBe(false),
  );
  test("rejects non-strings", () => {
    expect(isVersion(1)).toBe(false);
    expect(isVersion(null)).toBe(false);
  });
});

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
  });
  test("handles numbers beyond 2^53", () => {
    expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBeGreaterThan(0);
  });
  test("throws on non-versions", () => {
    expect(() => compareVersions("1.2", "1.2.3")).toThrow("not a version");
  });
  test("newestFirst", () => {
    expect(newestFirst(["0.2.0", "0.10.0", "0.9.1"])).toEqual(["0.10.0", "0.9.1", "0.2.0"]);
  });
});
