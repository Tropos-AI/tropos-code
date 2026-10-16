import { describe, expect, test } from "bun:test";
import { parseDotenv, parseJson5, parseYamlLite, sanitizeText } from "./text";

describe("sanitizeText", () => {
  test("strips BOM and control characters, normalises line ends", () => {
    expect(sanitizeText("﻿a\r\nb\x00\x07c\x1b[31m\td\u0085")).toBe("a\nbc[31m\td");
  });
});

describe("parseJson5", () => {
  test("comments, trailing commas, single quotes, unquoted keys", () => {
    const v = parseJson5(`// top\n{ agents: { defaults: { model: { primary: 'anthropic/x', }, }, }, /* c */ list: [1, 2,], hex: 0x10 }`) as any;
    expect(v.agents.defaults.model.primary).toBe("anthropic/x");
    expect(v.list).toEqual([1, 2]);
    expect(v.hex).toBe(16);
  });
  test("a __proto__ key is plain data", () => {
    const v = parseJson5(`{"__proto__": {"x": 1}}`) as any;
    expect(({} as any).x).toBeUndefined();
    expect(Object.keys(v)).toEqual(["__proto__"]);
  });
  test("garbage throws", () => {
    expect(() => parseJson5("{a: }")).toThrow();
    expect(() => parseJson5("{} x")).toThrow();
  });
});

describe("parseYamlLite", () => {
  test("flat and nested keys, quotes and comments", () => {
    const y = parseYamlLite(`# c\nmodel:\n  default: "anthropic/claude-x" # why\n  provider: openrouter\nother: 1\nlist:\n  - a\n`) as any;
    expect(y.model.default).toBe("anthropic/claude-x");
    expect(y.model.provider).toBe("openrouter");
    expect(y.other).toBe("1");
  });
  test("a scalar model", () => {
    expect((parseYamlLite("model: gpt-5\nprovider: openai") as any).model).toBe("gpt-5");
  });
});

describe("parseDotenv", () => {
  test("export, quotes, comments", () => {
    const e = parseDotenv(`# x\nexport A=1\nB="two words" # c\nC='q'\nD=plain # c\nbad line`);
    expect({ ...e }).toEqual({ A: "1", B: "two words", C: "q", D: "plain" });
  });
});
