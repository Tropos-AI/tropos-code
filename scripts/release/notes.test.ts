// scripts/release/notes.test.ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isVersion } from "../../src/install/version";
import { releaseNotes, VERIFY_FOOTER } from "./notes";

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

- Not yet.

## [0.5.3] - 2026-10-19

### Fixed

- The thing.

## [0.5.2] - 2026-10-18

- Older.

[0.5.3]: https://example.com/compare/v0.5.2...v0.5.3
`;

describe("release notes", () => {
  test("the notes are the version's own section, without its heading, then how to verify the release", () => {
    expect(releaseNotes(CHANGELOG, "0.5.3")).toBe(`### Fixed\n\n- The thing.\n\n${VERIFY_FOOTER}\n`);
  });

  test("the last section stops at the link references", () => {
    expect(releaseNotes(CHANGELOG, "0.5.2")).toBe(`- Older.\n\n${VERIFY_FOOTER}\n`);
  });

  test("a version without a section still gets the verification text, so a release is never blocked", () => {
    expect(releaseNotes(CHANGELOG, "9.9.9")).toBe(`${VERIFY_FOOTER}\n`);
  });

  test("a version is matched exactly, not as a prefix", () => {
    expect(releaseNotes(CHANGELOG.replace("## [0.5.2]", "## [0.5.20]"), "0.5.2")).toBe(`${VERIFY_FOOTER}\n`);
  });

  test("every version in the repository's CHANGELOG.md has notes", async () => {
    const changelog = await readFile(join(import.meta.dir, "../../CHANGELOG.md"), "utf8");
    const versions = [...changelog.matchAll(/^## \[(.+?)\]/gm)].map((m) => m[1]!).filter(isVersion);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(releaseNotes(changelog, v).length).toBeGreaterThan(VERIFY_FOOTER.length + 1);
  });
});
