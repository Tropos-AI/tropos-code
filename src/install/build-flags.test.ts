// src/install/build-flags.test.ts
import { describe, expect, test } from "bun:test";
import { IS_TEST_BUILD, testBuildOverrides } from "./build-flags";

describe("build flags", () => {
  test("dev and bun test runs are never test builds", () => {
    expect(IS_TEST_BUILD).toBe(false);
    expect(testBuildOverrides({ TROPOS_TEST_RELEASES_BASE: "http://127.0.0.1:1" })).toBeNull();
  });
});
