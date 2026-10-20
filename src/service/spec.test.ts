// src/service/spec.test.ts
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { programArguments } from "./spec";

let root: string | undefined;
afterEach(async () => {
  if (root) await removeDir(root);
});

test("an installed version runs through the ~/.local/bin/tcode link, so updates reach the service", async () => {
  root = await makeTmpDir("svc-spec-");
  const env = { HOME: root };
  const versions = join(root, ".local", "share", "tropos", "versions");
  mkdirSync(versions, { recursive: true });
  mkdirSync(join(root, ".local", "bin"), { recursive: true });
  const binary = join(versions, "0.5.0");
  writeFileSync(binary, "", { mode: 0o755 });
  symlinkSync(binary, join(root, ".local", "bin", "tcode"));
  expect(programArguments(binary, undefined, env)).toEqual([join(root, ".local", "bin", "tcode"), "gateway"]);
  // An older version the link no longer points at keeps its own path; so does anything outside the install.
  writeFileSync(join(versions, "0.4.1"), "", { mode: 0o755 });
  expect(programArguments(join(versions, "0.4.1"), undefined, env)).toEqual([join(versions, "0.4.1"), "gateway"]);
  expect(programArguments("/opt/tcode", undefined, env)).toEqual(["/opt/tcode", "gateway"]);
  expect(programArguments("/usr/bin/bun", "/src/cli.ts", env)).toEqual(["/usr/bin/bun", "/src/cli.ts", "gateway"]);
});

test("a Homebrew install runs through its opt link, which brew upgrade moves to the new version", async () => {
  root = await makeTmpDir("svc-spec-");
  const prefix = realpathSync(root);
  const keg = join(prefix, "Cellar", "tcode", "0.5.4");
  mkdirSync(join(keg, "bin"), { recursive: true });
  writeFileSync(join(keg, "bin", "tcode"), "", { mode: 0o755 });
  mkdirSync(join(prefix, "opt"));
  symlinkSync(keg, join(prefix, "opt", "tcode"));
  expect(programArguments(join(keg, "bin", "tcode"), undefined, { HOME: prefix })).toEqual([join(prefix, "opt", "tcode", "bin", "tcode"), "gateway"]);
});
