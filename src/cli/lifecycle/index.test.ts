// src/cli/lifecycle/index.test.ts
import { describe, expect, test } from "bun:test";
import { parseInvocation } from "../args";
import { LIFECYCLE_NAMES, isLifecycleName, loadLifecycle } from "./index";

describe("loadLifecycle", () => {
  for (const name of LIFECYCLE_NAMES) {
    test(`${name} resolves to a run function`, async () => {
      const run = await loadLifecycle(name);
      expect(typeof run).toBe("function");
    });
  }

  test("every name loads a distinct module", async () => {
    const runs = await Promise.all(LIFECYCLE_NAMES.map((n) => loadLifecycle(n)));
    expect(new Set(runs).size).toBe(LIFECYCLE_NAMES.length);
  });
});

describe("isLifecycleName", () => {
  test("accepts exactly the lifecycle names", () => {
    for (const name of LIFECYCLE_NAMES) expect(isLifecycleName(name)).toBe(true);
    for (const word of [undefined, "", "Status", "status ", "statuses", "web", "gateway", "--", "help"]) expect(isLifecycleName(word)).toBe(false);
  });
});

describe("parseInvocation and lifecycle words", () => {
  test("a bare lifecycle word is a lifecycle invocation carrying the rest of argv", () => {
    expect(parseInvocation(["status"])).toEqual({ kind: "lifecycle", name: "status", argv: [] });
    expect(parseInvocation(["logs", "--follow"])).toEqual({ kind: "lifecycle", name: "logs", argv: ["--follow"] });
  });

  test("after `--` the same word is a prompt, not a command", () => {
    const inv = parseInvocation(["--", "status"]);
    expect(inv.kind).toBe("session");
    expect(JSON.stringify(inv)).toContain("status");
  });
});
