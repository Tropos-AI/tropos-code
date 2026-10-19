// scripts/release/notes.ts
// A release's notes: its section of CHANGELOG.md, read from main (never from the tag), then how to verify it.
import { readFile } from "node:fs/promises";
import { isVersion } from "../../src/install/version";

export const VERIFY_FOOTER =
  "Every download is checked against the Tropos release key before it runs. To verify a release yourself, see " +
  "[Install and verify](https://github.com/Tropos-AI/tropos-code/blob/main/docs/install.md); the key fingerprint is in the README.";

/** The body of `## [version]` up to the next `## ` heading or the link references; a missing section only gets the footer. */
export function releaseNotes(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return `${VERIFY_FOOTER}\n`;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## ") || /^\[[^\]]+\]: /.test(line));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body ? `${body}\n\n${VERIFY_FOOTER}\n` : `${VERIFY_FOOTER}\n`;
}

if (import.meta.main) {
  const [version, out] = process.argv.slice(2);
  if (!isVersion(version) || !out) throw new Error("usage: bun scripts/release/notes.ts <version> <out-file>");
  await Bun.write(out, releaseNotes(await readFile("CHANGELOG.md", "utf8"), version));
}
