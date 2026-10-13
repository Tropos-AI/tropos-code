// scripts/release/pin-actions.test.ts
import { describe, expect, test } from "bun:test";
import { pinActions } from "./pin-actions";

describe("pinActions", () => {
  test("pins tags to SHAs and keeps the tag as a comment; idempotent", async () => {
    const resolve = async (repo: string, ref: string) => `${repo === "actions/checkout" ? "1" : "2"}`.repeat(40).slice(0, 40) + (ref ? "" : "");
    const input = "      - uses: actions/checkout@v5\n      - uses: oven-sh/setup-bun@v2\n        with:\n";
    const once = await pinActions(input, resolve);
    expect(once).toBe(`      - uses: actions/checkout@${"1".repeat(40)} # v5\n      - uses: oven-sh/setup-bun@${"2".repeat(40)} # v2\n        with:\n`);
    expect(await pinActions(once, resolve)).toBe(once);
  });
});
