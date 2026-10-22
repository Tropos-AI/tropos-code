// src/harness/domain.test.ts
import { expect, test } from "bun:test";
import { detectDomain, isDomain } from "./domain";

const only = (...files: string[]) => (path: string) => files.some((f) => path.endsWith(`/${f}`));

test("the stack decides the domain; bun wins over a plain package.json", () => {
  expect(detectDomain("/r", only("package.json", "bun.lock"))).toBe("ts-bun");
  expect(detectDomain("/r", only("package.json"))).toBe("ts-node");
  expect(detectDomain("/r", only("Cargo.toml"))).toBe("rust");
  expect(detectDomain("/r", only("go.mod"))).toBe("go");
  expect(detectDomain("/r", only("requirements.txt"))).toBe("python");
  expect(detectDomain("/r", only())).toBe("general");
});

test("a package.json that runs bun is a Bun project, lockfile or not", () => {
  const pkg = (json: unknown) => () => JSON.stringify(json);
  expect(detectDomain("/r", only("package.json"), pkg({ scripts: { test: "bun test" } }))).toBe("ts-bun");
  expect(detectDomain("/r", only("package.json"), pkg({ devDependencies: { "@types/bun": "1" } }))).toBe("ts-bun");
  expect(detectDomain("/r", only("package.json"), pkg({ scripts: { test: "vitest", build: "rollup" } }))).toBe("ts-node");
  expect(detectDomain("/r", only("package.json"), () => "{broken")).toBe("ts-node");
});

test("isDomain", () => {
  expect(isDomain("python")).toBe(true);
  expect(isDomain("cobol")).toBe(false);
});
