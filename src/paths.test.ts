// src/paths.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  absolutePathEnv, agentsDir, expandHome, isInside, journalDir, learnedSkillsDir, projectKey, readSmallFileSync, safeWhich, troposHome,
  userSkillsDir, workspaceDir, workspaceFile,
} from "./paths";

describe("readSmallFileSync", () => {
  test("reads a small plain file; a link, a FIFO, a folder, a missing or an oversized file give null at once", () => {
    const dir = mkdtempSync(join(tmpdir(), "tropos-small-"));
    try {
      writeFileSync(join(dir, "marker"), "/work/app\n");
      expect(readSmallFileSync(join(dir, "marker"), 64)).toBe("/work/app\n");
      symlinkSync("/dev/zero", join(dir, "zero"));
      expect(readSmallFileSync(join(dir, "zero"), 64)).toBeNull();
      expect(Bun.spawnSync(["mkfifo", join(dir, "fifo")]).exitCode).toBe(0);
      expect(readSmallFileSync(join(dir, "fifo"), 64)).toBeNull();
      expect(readSmallFileSync(dir, 64)).toBeNull();
      expect(readSmallFileSync(join(dir, "missing"), 64)).toBeNull();
      writeFileSync(join(dir, "big"), "x".repeat(65));
      expect(readSmallFileSync(join(dir, "big"), 64)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("projectKey", () => {
  test("starts with a readable, sanitized form of the path", () => {
    expect(projectKey("/work/my app").startsWith("-work-my-app-")).toBe(true);
  });
  test("ends with 12 hex characters of a sha256 hash", () => {
    expect(projectKey("/work/my app")).toMatch(/-[0-9a-f]{12}$/);
  });
  test("is deterministic", () => {
    expect(projectKey("/work/my app")).toBe(projectKey("/work/my app"));
  });
  test("paths that flatten to the same prefix do not collide", () => {
    expect(projectKey("/a/b-c")).not.toBe(projectKey("/a-b/c"));
  });
});

describe("troposHome", () => {
  test("uses TROPOS_HOME when set", () => {
    expect(troposHome({ TROPOS_HOME: "/tmp/th" })).toBe("/tmp/th");
  });
  test("falls back to ~/.tropos", () => {
    expect(troposHome({})).toBe(join(homedir(), ".tropos"));
  });
  test("ignores an empty TROPOS_HOME", () => {
    expect(troposHome({ TROPOS_HOME: "" })).toBe(join(homedir(), ".tropos"));
  });
});

describe("expandHome", () => {
  test("expands a leading ~/", () => {
    expect(expandHome("~/x/y", "/home/u")).toBe("/home/u/x/y");
  });
  test("expands a bare ~", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
  });
  test("leaves other paths alone", () => {
    expect(expandHome("/a/~b", "/home/u")).toBe("/a/~b");
  });
});

describe("isInside", () => {
  test("the dir itself counts as inside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });
  test("a child is inside", () => {
    expect(isInside("/a/b/c.ts", "/a/b")).toBe(true);
  });
  test("a sibling with a shared prefix is outside", () => {
    expect(isInside("/a/bc/d", "/a/b")).toBe(false);
  });
  test("a parent is outside", () => {
    expect(isInside("/a", "/a/b")).toBe(false);
  });
  test("a child whose name starts with .. is inside", () => {
    expect(isInside("/a/b/..cache/x", "/a/b")).toBe(true);
  });
});

describe("safeWhich", () => {
  test("ignores relative PATH entries and programs inside the project", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const base = await mkdtemp(join(tmpdir(), "tropos-which-"));
    try {
      const repo = join(base, "repo");
      const bin = join(repo, "node_modules", ".bin");
      const outside = join(base, "tools");
      await mkdir(bin, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(bin, "prettier"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(join(outside, "prettier"), "#!/bin/sh\n", { mode: 0o755 });
      expect(absolutePathEnv(`node_modules/.bin:.:${outside}::`)).toBe(outside);
      // An absolute PATH entry that points into the repo is refused too.
      expect(safeWhich("prettier", repo, bin)).toBeNull();
      expect(safeWhich("prettier", repo, `${bin}:${outside}`)).toBe(join(outside, "prettier"));
      const { symlink } = await import("node:fs/promises");
      const linkDir = join(base, "links");
      await mkdir(linkDir);
      await symlink(join(bin, "prettier"), join(linkDir, "prettier"));
      expect(safeWhich("prettier", repo, linkDir)).toBeNull();
      expect(safeWhich("prettier", repo, `node_modules/.bin:${outside}`)).toBe(join(outside, "prettier"));
      expect(safeWhich("prettier", undefined, bin)).toBe(join(bin, "prettier"));
      expect(safeWhich("nope", repo, outside)).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("workspace layout paths", () => {
  test("the workspace holds the chief's files; agents stay at the root", () => {
    expect(workspaceDir("/h")).toBe("/h/workspace");
    expect(workspaceFile("/h", "USER.md")).toBe("/h/workspace/USER.md");
    expect(journalDir("/h")).toBe("/h/workspace/memory");
    expect(userSkillsDir("/h")).toBe("/h/workspace/skills");
    expect(learnedSkillsDir("/h")).toBe("/h/workspace/skills-learned");
    expect(agentsDir("/h")).toBe("/h/agents");
  });
});
