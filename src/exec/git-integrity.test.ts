// src/exec/git-integrity.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMONDIR_TAMPERED, commondirSnapshot, enforceCommondir } from "./git-integrity";

let fx: string;
let git: string;
beforeEach(() => {
  fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-gi-")));
  git = join(fx, ".git");
  mkdirSync(git, { recursive: true });
});
afterEach(() => rmSync(fx, { recursive: true, force: true }));

test("a commondir created during a command is removed and the tamper reported", () => {
  const before = commondirSnapshot([git]);
  expect(before.size).toBe(0);
  writeFileSync(join(git, "commondir"), "/attacker/.git"); // what a confined command plants
  expect(enforceCommondir([git], before)).toBe(COMMONDIR_TAMPERED);
  expect(existsSync(join(git, "commondir"))).toBe(false);
});

test("a commondir that was already there (a real linked worktree) is left alone", () => {
  writeFileSync(join(git, "commondir"), "../..");
  const before = commondirSnapshot([git]);
  expect(before.has(join(git, "commondir"))).toBe(true);
  expect(enforceCommondir([git], before)).toBeNull();
  expect(existsSync(join(git, "commondir"))).toBe(true);
});

test("no change means no report", () => {
  const before = commondirSnapshot([git]);
  expect(enforceCommondir([git], before)).toBeNull();
});

test("every git dir is checked, so a submodule's commondir is caught too", () => {
  const sub = join(git, "modules", "lib");
  mkdirSync(sub, { recursive: true });
  const before = commondirSnapshot([git, sub]);
  writeFileSync(join(sub, "commondir"), "/attacker");
  expect(enforceCommondir([git, sub], before)).toBe(COMMONDIR_TAMPERED);
  expect(existsSync(join(sub, "commondir"))).toBe(false);
});
