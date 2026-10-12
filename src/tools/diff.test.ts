import { describe, expect, test } from "bun:test";
import { makeDiff, patchBody } from "./diff";

describe("makeDiff", () => {
  test("counts added and removed lines", () => {
    const d = makeDiff("a.ts", "one\ntwo\n", "one\nthree\nfour\n");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
  });

  test("counts content lines that start like file headers", () => {
    const d = makeDiff("q.sql", "-- old sql\nkeep\n++i;\n", "keep\n+j;\n");
    expect(d.removed).toBe(2);
    expect(d.added).toBe(1);
  });
});

describe("patchBody", () => {
  test("drops the file header by position", () => {
    const body = patchBody(makeDiff("a.ts", "x\n", "y\n").patch);
    expect(body[0]).toStartWith("@@");
    expect(body).toContain("-x");
    expect(body).toContain("+y");
  });

  test("an unchanged file has no body", () => {
    expect(patchBody(makeDiff("a.ts", "x\n", "x\n").patch)).toEqual([]);
  });
});
