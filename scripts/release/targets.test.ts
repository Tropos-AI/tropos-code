// scripts/release/targets.test.ts
import { describe, expect, test } from "bun:test";
import { PLATFORMS } from "../../src/install/platform";
import { RELEASE_TARGETS } from "./targets";

describe("release targets", () => {
  test("one Bun target per release platform, including both musl targets", () => {
    expect(Object.keys(RELEASE_TARGETS)).toEqual([...PLATFORMS]);
    expect(RELEASE_TARGETS["linux-x64-musl"]).toBe("bun-linux-x64-musl");
    expect(RELEASE_TARGETS["linux-arm64-musl"]).toBe("bun-linux-arm64-musl");
  });
});
