// src/install/markers.test.ts
import { describe, expect, test } from "bun:test";
import { FISH_PATH_BLOCK, PATH_BLOCK_BEGIN, POSIX_PATH_BLOCK, hasPathBlock, stripPathBlock } from "./markers";

describe("stripPathBlock", () => {
  test("removes the block and nothing else", () => {
    const rc = `export A=1\n\n${POSIX_PATH_BLOCK}alias ll='ls -l'\n`;
    expect(stripPathBlock(rc)).toBe("export A=1\nalias ll='ls -l'\n");
  });
  test("a file that is only the block becomes empty", () => {
    expect(stripPathBlock(POSIX_PATH_BLOCK)).toBe("");
    expect(stripPathBlock(FISH_PATH_BLOCK)).toBe("");
  });
  test("every block is removed, an untouched file is returned as it was", () => {
    expect(stripPathBlock(`${POSIX_PATH_BLOCK}x\n${POSIX_PATH_BLOCK}`)).toBe("x\n");
    expect(stripPathBlock("export A=1\n")).toBe("export A=1\n");
  });
  test("an unterminated marker is left alone rather than eating the rest of the file", () => {
    const rc = `a\n${PATH_BLOCK_BEGIN}\nexport B=2\n`;
    expect(stripPathBlock(rc)).toBe(rc);
  });
  test("hasPathBlock needs both markers", () => {
    expect(hasPathBlock(POSIX_PATH_BLOCK)).toBe(true);
    expect(hasPathBlock(PATH_BLOCK_BEGIN)).toBe(false);
  });
});
